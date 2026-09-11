# Copyright (c) 2025 Efstratios Goudelis
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program. If not, see <https://www.gnu.org/licenses/>.

"""Tracker message handling for Socket.IO events."""

import asyncio
import logging
import time
from typing import Any, Dict

from celestial.scene import build_observer_sky_bodies
from common.constants import SocketEvents
from tracker.contracts import InvalidTrackerIdError, require_tracker_id
from tracker.operations import operations
from tracker.runner import get_existing_tracker_manager, queue_from_tracker
from vfos.updates import handle_vfo_updates_for_tracking

logger = logging.getLogger(__name__)

# Global storage for tracker stats (accessed by performance monitor)
tracker_stats: Dict[str, Any] = {}
_observer_bodies_cache: list[Dict[str, Any]] = []
_observer_bodies_cache_updated_at = 0.0
OBSERVER_BODIES_CACHE_SECONDS = 15.0


async def _get_live_observer_bodies() -> list[Dict[str, Any]]:
    """Cache the Sun briefly so every tracker event carries useful sky context."""
    global _observer_bodies_cache, _observer_bodies_cache_updated_at

    now = time.monotonic()
    if (
        _observer_bodies_cache
        and now - _observer_bodies_cache_updated_at < OBSERVER_BODIES_CACHE_SECONDS
    ):
        return _observer_bodies_cache

    try:
        _observer_bodies_cache = await build_observer_sky_bodies(
            data={"past_hours": 0, "future_hours": 1, "step_minutes": 60},
            logger=logger,
        )
        _observer_bodies_cache_updated_at = now
    except Exception as exc:  # pragma: no cover - observer context must not block tracking updates
        logger.warning("Unable to calculate live observer bodies: %s", exc)
    return _observer_bodies_cache


async def handle_tracker_messages(sockio):
    """
    Continuously checks for messages from the tracker process.

    Processes messages from the tracker queue and emits them as Socket.IO events.
    Also handles VFO updates for SDR tracking when satellite-tracking events are received.

    Args:
        sockio: Socket.IO server instance for emitting events
    """
    while True:
        try:
            processed = False
            if queue_from_tracker is not None and not queue_from_tracker.empty():
                message = queue_from_tracker.get_nowait()
                processed = True
                msg_type = message.get("type")
                event = message.get("event")
                data = message.get("data", {})
                if not isinstance(data, dict):
                    data = {}

                # Handle stats messages
                if msg_type == "stats":
                    try:
                        tracker_id = require_tracker_id(message.get("tracker_id"))
                    except InvalidTrackerIdError:
                        logger.debug("Dropping stats message without tracker_id")
                        await asyncio.sleep(0)
                        continue
                    tracker_stats[tracker_id] = message.get("stats", {})
                elif event:
                    try:
                        tracker_id = require_tracker_id(
                            message.get("tracker_id") or data.get("tracker_id")
                        )
                    except InvalidTrackerIdError:
                        logger.debug("Dropping tracker event '%s' without tracker_id", event)
                        await asyncio.sleep(0)
                        continue
                    data["tracker_id"] = tracker_id
                    if event == SocketEvents.TRACKER_COMMAND_STATUS:
                        record = operations.existing(data.get("command_id"), tracker_id)
                        if record and record.get("epoch") == data.get("epoch") == operations.epoch:
                            if record.get("worker_generation") and record[
                                "worker_generation"
                            ] != data.get("worker_generation"):
                                continue
                            if data.get("worker_generation") and not record.get(
                                "worker_generation"
                            ):
                                operations.records[data["command_id"]]["worker_generation"] = data[
                                    "worker_generation"
                                ]
                            snapshot = data.get("snapshot")
                            if snapshot:
                                # A result from a replaced worker cannot rewrite
                                # desired state before observation ordering runs.
                                if not operations.can_observe(snapshot):
                                    continue
                                manager = get_existing_tracker_manager(tracker_id)
                                if manager and record["status"] not in {
                                    "succeeded",
                                    "failed",
                                    "cancelled",
                                }:
                                    await manager.reconcile_operation(record, snapshot)
                                operations.observe(snapshot)
                            operations.update(
                                data["command_id"],
                                data["status"],
                                data.get("reason"),
                                snapshot,
                                reconciled=data.get("reconciled"),
                            )
                        continue
                    if event == "tracker-hardware-state":
                        manager = get_existing_tracker_manager(tracker_id)
                        if manager and manager.current_tracking_state:
                            data["desired_state"] = dict(manager.current_tracking_state)
                        operations.observe(data)
                    if event == SocketEvents.SATELLITE_TRACKING and not data.get("observer_bodies"):
                        # Satellites do not carry heliocentric Earth vectors in
                        # their worker payload, so attach the shared live Sun here.
                        data["observer_bodies"] = await _get_live_observer_bodies()
                    await sockio.emit(event, data)
                    if event == SocketEvents.SATELLITE_TRACKING:
                        await sockio.emit(SocketEvents.SATELLITE_TRACKING_V2, data)

                    # Handle VFO updates for SDR tracking
                    if event == "satellite-tracking" and data.get("rig_data"):
                        await handle_vfo_updates_for_tracking(sockio, data)

            await asyncio.sleep(0 if processed else 0.05)
        except Exception as e:  # pragma: no cover - best effort
            logger.error(f"Error handling tracker messages: {e}")
            await asyncio.sleep(1)


async def handle_command_updates(sockio):
    """Deadlines and command broadcasts must not wait for sky/VFO processing."""
    while True:
        try:
            # Deadlines do not depend on the worker producing another update.
            for expired in operations.expire():
                manager = get_existing_tracker_manager(expired["tracker_id"])
                if manager:
                    manager._send_to_tracker(
                        "cancel_operation", {"command_id": expired["command_id"]}
                    )
            while operations.outbox:
                await sockio.emit(SocketEvents.TRACKER_COMMAND_STATUS, operations.outbox.pop(0))
        except Exception:
            logger.exception("Failed publishing tracker command status")
        await asyncio.sleep(0.1)
