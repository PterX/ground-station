# Copyright (c) 2026 Efstratios Goudelis
"""Recoverable command records, independent of hardware and Socket.IO."""

import asyncio
import copy
import json
import os
import time
import uuid
from pathlib import Path
from typing import Any, Optional

from tracker.contracts import requests_rotator_motion

ACTIVE = {"submitted", "started", "unknown"}
TERMINAL = {"succeeded", "failed", "cancelled"}
ROTATOR_KEYS = {"rotator_state", "rotator_id"}
RIG_KEYS = {"rig_state", "rig_id", "transmitter_id", "rig_vfo", "vfo1", "vfo2"}


def command_scopes(changes: dict, action: str = "") -> list[str]:
    scopes = []
    if ROTATOR_KEYS.intersection(changes) or action == "move" or (action == "stop" and not changes):
        scopes.append("rotator")
    if RIG_KEYS.intersection(changes):
        scopes.append("rig")
    if set(changes) - ROTATOR_KEYS - RIG_KEYS:
        scopes.append("target")
    return scopes or ["target"]


class OperationRegistry:
    """One supervisor owns this journal; workers send results through IPC only."""

    def __init__(self, path: Optional[Path] = None):
        self.lock = asyncio.Lock()
        self.epoch = str(uuid.uuid4())
        self.revision = 0
        self.records: dict[str, dict[str, Any]] = {}
        self.observed: dict[str, dict[str, Any]] = {}
        self.outbox: list[dict] = []
        self.path = path
        if path and path.exists():
            saved = json.loads(path.read_text())
            self.records = saved.get("records", {})
            self.revision = saved.get("revision", 0)
            # Never replay commands after a restart. Retain their identity and
            # explain why the old execution result can no longer be confirmed.
            for record in list(self.records.values()):
                if record["status"] in ACTIVE and not record.get("reconciled"):
                    self.update(
                        record["command_id"], "unknown", "Backend restarted; outcome unknown"
                    )

    def persist(self):
        if not self.path:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Keep a bounded retry history without evicting outstanding operations.
        finished = [
            key
            for key, row in self.records.items()
            if row["status"] in TERMINAL or row.get("reconciled")
        ]
        for key in finished[:-500]:
            del self.records[key]
        temporary = self.path.with_suffix(".tmp")
        with temporary.open("w") as stream:
            json.dump({"revision": self.revision, "records": self.records}, stream)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(self.path)

    def existing(self, command_id: Optional[str], tracker_id: str) -> Optional[dict]:
        record = self.records.get(command_id or "")
        if record and record["tracker_id"] != tracker_id:
            raise ValueError("Command ID belongs to another tracker")
        return copy.deepcopy(record)

    def accept(
        self, tracker_id: str, changes: dict, state: dict, request: Optional[dict] = None
    ) -> dict:
        request = request or {}
        command_id = str(request.get("command_id") or uuid.uuid4())
        existing = self.existing(command_id, tracker_id)
        if existing:
            return existing
        if time.time() > request.get("accept_before", float("inf")):
            raise ValueError("Request expired before acceptance")
        action = request.get("action") or "configure"
        scopes = command_scopes(changes, action)
        devices = {scope: state.get(f"{scope}_id") for scope in scopes if scope != "target"}
        expected = request.get("device_ids") or {}
        for scope, device in expected.items():
            if device != state.get(f"{scope}_id"):
                raise ValueError("Device assignment changed; refresh before retrying")
        supersedes = list(request.get("supersedes") or [])
        is_stop = action == "stop" or changes.get("rotator_state") == "stopped"
        resources = {
            f"{scope}:{device}"
            for scope, device in devices.items()
            if device not in (None, "", "none")
        }
        for other_id, observed in self.observed.items():
            if (
                requests_rotator_motion(action, changes)
                and devices.get("rotator") == observed.get("tracking_state", {}).get("rotator_id")
                and observed.get("rotator_data", {}).get("motion_unconfirmed")
            ):
                raise ValueError(
                    "Rotator motion is unconfirmed; wait for stationary position readings"
                )
            if other_id == tracker_id:
                continue
            for scope, device in devices.items():
                if (
                    device not in (None, "", "none")
                    and observed.get("tracking_state", {}).get(f"{scope}_id") == device
                    and observed.get(f"{scope}_data", {}).get("connected")
                ):
                    raise ValueError("Device is connected to another tracker")
        for record in list(self.records.values()):
            if record["status"] not in ACTIVE or record.get("reconciled"):
                continue
            same_tracker = record["tracker_id"] == tracker_id
            overlaps = (same_tracker and bool(set(scopes) & set(record["scopes"]))) or bool(
                resources & set(record["resources"])
            )
            if not overlaps:
                continue
            if is_stop and same_tracker and set(scopes).intersection(record["scopes"]):
                # Acceptance alone cannot cancel running hardware. Keep the
                # earlier operation outstanding until the worker handles Stop;
                # persistence or queueing of Stop can still fail here.
                if record["command_id"] not in supersedes:
                    supersedes.append(record["command_id"])
            else:
                raise ValueError("A command is already in progress for this device")
        # A Stop can precede a delayed Move request. Tombstones prevent that
        # explicitly cancelled request from becoming a new movement later.
        for cancelled_id in supersedes if is_stop else []:
            if cancelled_id not in self.records:
                self.records[cancelled_id] = {
                    "command_id": cancelled_id,
                    "tracker_id": tracker_id,
                    "status": "cancelled",
                    "scopes": scopes,
                    "scope": scopes[0],
                    "resources": list(resources),
                    "device_ids": devices,
                    "action": "configure",
                    "reason": "Superseded by Stop",
                    "revision": 0,
                    "epoch": self.epoch,
                }
                self.update(cancelled_id, "cancelled", "Superseded by Stop")
        self.revision += 1
        now = time.time()
        duration = (
            180 if action in {"move", "park"} or changes.get("rotator_state") == "parked" else 30
        )
        record = {
            "command_id": command_id,
            "tracker_id": tracker_id,
            "action": action,
            "scope": scopes[0] if len(scopes) == 1 else "tracking",
            "scopes": scopes,
            "resources": sorted(resources),
            "device_ids": devices,
            "changes": dict(changes),
            "requested_state": dict(changes),
            "status": "submitted",
            "reason": None,
            "revision": self.revision,
            "epoch": self.epoch,
            "worker_generation": self.observed.get(tracker_id, {}).get("worker_generation"),
            "submitted_at": now,
            "updated_at": now,
            "deadline": now + duration,
            "position": request.get("position"),
            "supersedes": supersedes,
        }
        self.records[command_id] = record
        self.persist()
        self.outbox.append(copy.deepcopy(record))
        return copy.deepcopy(record)

    def update(
        self, command_id: str, status: str, reason=None, snapshot=None, *, reconciled=None
    ) -> Optional[dict]:
        record = self.records.get(command_id)
        if not record:
            return None
        if record["status"] in TERMINAL and record["status"] != status:
            return None
        if status == "started" and record["status"] != "submitted":
            return None
        self.revision += 1
        record.update(status=status, reason=reason, revision=self.revision, updated_at=time.time())
        if reconciled is not None:
            record["reconciled"] = reconciled
        if snapshot:
            record["snapshot"] = snapshot
        self.persist()
        self.outbox.append(copy.deepcopy(record))
        return copy.deepcopy(record)

    def expire(self) -> list[dict]:
        expired = []
        for record in list(self.records.values()):
            if record["status"] in {"submitted", "started"} and time.time() > record["deadline"]:
                self.update(
                    record["command_id"],
                    "unknown",
                    "Worker deadline exceeded; awaiting reconciliation",
                )
                expired.append(copy.deepcopy(record))
        return expired

    def can_observe(self, data):
        previous = self.observed.get(data["tracker_id"], {})
        if previous.get("worker_started_at", 0) > data.get("worker_started_at", 0):
            return False
        if previous.get("worker_generation") == data.get("worker_generation") and previous.get(
            "sequence", 0
        ) >= data.get("sequence", 0):
            return False
        return True

    def observe(self, data):
        if not self.can_observe(data):
            return
        tracker_id = data["tracker_id"]
        self.observed[tracker_id] = copy.deepcopy(data)
        for record in list(self.records.values()):
            if (
                record["tracker_id"] != tracker_id
                or record["status"] not in ACTIVE
                or record.get("reconciled")
            ):
                continue
            restarted = record.get("epoch") != self.epoch or (
                record.get("worker_generation")
                and record["worker_generation"] != data.get("worker_generation")
            )
            if restarted:
                record["reconciled"] = True
                self.update(
                    record["command_id"],
                    "unknown",
                    "Previous worker ended; outcome unconfirmed. Current hardware state restored",
                )

    def snapshot(self) -> dict:
        return copy.deepcopy(
            {
                "server_time": time.time(),
                "epoch": self.epoch,
                "revision": self.revision,
                "commands": list(self.records.values()),
                "trackers": self.observed,
            }
        )


operations = OperationRegistry()
