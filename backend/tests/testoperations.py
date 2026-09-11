# Copyright (c) 2026 Efstratios Goudelis
import asyncio
import queue
import threading
import time
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from db.models import TrackingState
from tracker import logic
from tracker import manager as managermodule
from tracker.execution import WorkerOperations
from tracker.manager import TrackerManager
from tracker.operations import OperationRegistry

STATE = {
    "rotator_id": "mount",
    "rotator_state": "connected",
    "rig_id": "radio",
    "rig_state": "disconnected",
}


def request(registry, key="move", tracker="target-1", action="move", changes=None):
    return registry.accept(
        tracker,
        changes or {},
        STATE,
        {
            "command_id": key,
            "action": action,
            "position": {"az": 120, "el": 45},
        },
    )


def test_independent_devices_keep_both_commands_and_reject_shared_device():
    registry = OperationRegistry()
    request(registry)
    request(registry, "rig", action="connect", changes={"rig_state": "connected"})
    assert len(registry.records) == 2
    with pytest.raises(ValueError, match="in progress"):
        request(registry, "another", tracker="target-2")


def test_stop_cancels_pending_move_and_fences_a_late_request():
    registry = OperationRegistry()
    request(registry)
    stop = registry.accept(
        "target-1",
        {"rotator_state": "stopped"},
        STATE,
        {"command_id": "stop", "action": "stop", "supersedes": ["late"]},
    )
    assert stop["status"] == "submitted"
    assert registry.records["move"]["status"] == "submitted"
    assert "move" in stop["supersedes"]
    assert request(registry, "late")["status"] == "cancelled"
    registry.update("stop", "failed", "Could not persist Stop")
    assert registry.records["move"]["status"] == "submitted"


def test_rig_stop_does_not_cancel_or_change_rotator_operation():
    registry = OperationRegistry()
    move = request(registry)
    request(registry, "rig", action="connect", changes={"rig_state": "connected"})
    stop = registry.accept("target-1", {"rig_state": "stopped"}, STATE, {"action": "stop"})
    assert stop["scopes"] == ["rig"]
    assert registry.records["move"]["status"] == "submitted"
    assert "rig" in stop["supersedes"]
    tracker = worker()
    tracker.operations.accept({"operation": move})
    tracker.operations.accept(
        {
            "operation": stop,
            "messages": [
                {"type": "set_tracking_state", "payload": {**STATE, "rig_state": "stopped"}}
            ],
        }
    )
    tracker.operations.begin_cycle()
    assert "move" in tracker.operations.pending
    assert tracker.input_tracking_state["rotator_state"] == "connected"


def test_deadline_advances_without_telemetry_and_cannot_be_downgraded():
    registry = OperationRegistry()
    record = request(registry)
    registry.records[record["command_id"]]["deadline"] = time.time() - 1
    assert len(registry.expire()) == 1
    assert registry.records["move"]["status"] == "unknown"
    registry.update("move", "cancelled")
    assert registry.update("move", "succeeded") is None


def test_recovery_retains_ids_without_replaying_and_reconciles_after_fresh_snapshot(tmp_path):
    journal = tmp_path / "commands.json"
    first = OperationRegistry(journal)
    request(first)
    recovered = OperationRegistry(journal)
    assert recovered.records["move"]["status"] == "unknown"
    assert request(recovered)["status"] == "unknown"
    recovered.observe({"tracker_id": "target-1", "worker_generation": "new", "sequence": 1})
    assert recovered.records["move"]["reconciled"] is True
    request(recovered, "new-move")
    recovered.update("new-move", "succeeded")
    again = OperationRegistry(journal)
    assert again.records["move"]["reconciled"] is True
    assert again.records["new-move"]["status"] == "succeeded"


def test_expired_or_reassigned_request_is_rejected():
    registry = OperationRegistry()
    with pytest.raises(ValueError, match="expired"):
        registry.accept("target-1", {}, STATE, {"action": "move", "accept_before": time.time() - 1})
    with pytest.raises(ValueError, match="assignment"):
        registry.accept(
            "target-1", {}, STATE, {"action": "move", "device_ids": {"rotator": "other"}}
        )


def test_partial_telemetry_cannot_complete_any_command():
    manager = TrackerManager(tracker_id="target-1")
    assert (
        manager.process_tracking_update({"tracker_id": "target-1", "rig_data": {"connected": True}})
        == []
    )


def worker():
    tracker = logic.SatelliteTracker(queue.Queue(), queue.Queue(), tracker_id="target-1")
    tracker.input_tracking_state = dict(STATE)
    tracker.rotator_data.update(connected=True, stopped=True)
    tracker.rotator_handler._target_within_tolerance = (
        lambda az, el, target_az, target_el: abs(az - target_az) < 1 and abs(el - target_el) < 1
    )
    return tracker


def test_worker_only_completes_move_from_fresh_arrival_readings():
    tracker = worker()
    operation = request(OperationRegistry())
    tracker.operations.accept({"operation": operation})
    tracker.operations.begin_cycle()
    tracker.rotator_data.update(az=120, el=45)
    tracker.operations.finish_cycle()
    assert "move" in tracker.operations.pending
    tracker.rotator_position_fresh = True
    tracker.operations.finish_cycle()
    assert "move" in tracker.operations.pending
    tracker.operations.finish_cycle()
    assert "move" not in tracker.operations.pending


def test_worker_reports_changed_assignment_and_expired_commands():
    tracker = worker()
    operation = request(OperationRegistry())
    tracker.operations.accept({"operation": operation})
    tracker.input_tracking_state["rotator_id"] = "other"
    tracker.operations.begin_cycle()
    assert not tracker.operations.pending
    event = tracker.queue_out._queue_out.get_nowait()
    assert event["data"]["status"] == "cancelled"
    operation["deadline"] = time.time() - 1
    tracker.operations.accept(
        {"operation": operation, "messages": [{"type": "set_tracking_state", "payload": STATE}]}
    )
    assert tracker.input_tracking_state["rotator_id"] == "other"
    assert tracker.queue_out._queue_out.get_nowait()["data"]["status"] == "failed"


def test_expiry_after_dequeue_cannot_apply_the_expired_state():
    tracker = worker()
    operation = request(
        OperationRegistry(), "track", action="track", changes={"rotator_state": "tracking"}
    )
    tracker.operations.accept(
        {
            "operation": operation,
            "messages": [
                {"type": "set_tracking_state", "payload": {**STATE, "rotator_state": "tracking"}}
            ],
        }
    )
    tracker.operations.pending["track"]["deadline"] = time.time() - 1
    tracker.operations.begin_cycle()
    assert tracker.input_tracking_state["rotator_state"] == "connected"
    assert not tracker.operations.pending


def test_independent_rig_batch_does_not_restore_failed_rotator_state():
    tracker = worker()
    tracker.input_tracking_state["rotator_state"] = "disconnected"
    operation = request(
        OperationRegistry(), "rig", action="connect", changes={"rig_state": "connected"}
    )
    tracker.operations.accept(
        {
            "operation": operation,
            "messages": [
                {"type": "set_tracking_state", "payload": {**STATE, "rig_state": "connected"}}
            ],
        }
    )
    assert tracker.input_tracking_state["rig_state"] == "connected"
    assert tracker.input_tracking_state["rotator_state"] == "disconnected"


def test_worker_error_precedes_success_flags():
    tracker = worker()
    operation = request(
        OperationRegistry(), "connect", action="connect", changes={"rotator_state": "connected"}
    )
    tracker.operations.accept({"operation": operation})
    tracker.operations.begin_cycle()
    tracker.rotator_data.update(error=True, connected=True)
    tracker.operations.finish_cycle()
    events = list(tracker.queue_out._queue_out.queue)
    assert events[-1]["data"]["status"] == "failed"


@pytest.mark.asyncio
async def test_manual_move_and_stop_execute_without_location_or_target(monkeypatch):
    monkeypatch.setattr(logic, "args", SimpleNamespace(track_interval_ms=1))
    tracker = worker()
    stopped = threading.Event()
    tracker.stop_event = stopped
    controller = SimpleNamespace(
        stop=AsyncMock(return_value=True), get_position=AsyncMock(return_value=(120, 45))
    )
    tracker.rotator_controller = controller
    tracker.prev_rotator_state = "connected"
    tracker.rotator_details = {"azimuth_mode": "0_360"}
    sent = []

    async def issue(az, el):
        sent.append((az, el))

    tracker.rotator_handler._issue_rotator_command = issue
    registry = OperationRegistry()
    tracker.operations.accept({"operation": request(registry)})
    original_publish = tracker.operations.publish
    ticks = 0

    def publish():
        nonlocal ticks
        ticks += 1
        original_publish()
        if ticks == 1:
            operation = registry.accept(
                "target-1", {"rotator_state": "stopped"}, STATE, {"action": "stop"}
            )
            tracker.operations.accept(
                {
                    "operation": operation,
                    "messages": [
                        {
                            "type": "set_tracking_state",
                            "payload": {**STATE, "rotator_state": "stopped"},
                        }
                    ],
                }
            )
        elif ticks == 2:
            stopped.set()

    tracker.operations.publish = publish
    await asyncio.wait_for(tracker.run(), timeout=2)
    assert sent == [(120, 45)]
    controller.stop.assert_awaited_once()


@pytest.mark.asyncio
async def test_park_waits_for_arrival_and_stop_calls_controller():
    tracker = worker()
    tracker.current_rotator_state = "parked"
    tracker.rotator_details = {"parkaz": 120, "parkel": 45, "azimuth_mode": "0_360"}
    tracker.rotator_controller = SimpleNamespace(
        park=AsyncMock(return_value=True),
        stop=AsyncMock(return_value=True),
        get_position=AsyncMock(return_value=(20, 10)),
    )
    await tracker.rotator_handler.park_rotator()
    assert tracker.rotator_data["parked"] is False
    await tracker.rotator_handler.update_hardware_position()
    assert tracker.rotator_data["parked"] is False
    tracker.rotator_controller.get_position.return_value = (120, 45)
    await tracker.rotator_handler.update_hardware_position()
    await tracker.rotator_handler.update_hardware_position()
    assert tracker.rotator_data["parked"] is True
    await tracker.rotator_handler.handle_rotator_state_change("parked", "stopped")
    tracker.rotator_controller.stop.assert_awaited_once()


@pytest.mark.asyncio
async def test_expiring_running_move_waits_for_physical_stop():
    tracker = worker()
    tracker.rotator_controller = SimpleNamespace(stop=AsyncMock(return_value=True))
    tracker.operations.accept({"operation": request(OperationRegistry())})
    tracker.operations.begin_cycle()
    tracker.rotator_data.update(stopped=False, slewing=True)
    tracker.operations.cancel("move")
    tracker.operations.finish_cycle()
    assert "move" in tracker.operations.pending
    await tracker.rotator_handler.handle_rotator_state_change("connected", "stopped")
    tracker.operations.finish_cycle()
    tracker.rotator_controller.stop.assert_awaited_once()
    assert "move" not in tracker.operations.pending
    assert list(tracker.queue_out._queue_out.queue)[-1]["data"]["status"] == "cancelled"


@pytest.mark.asyncio
async def test_failed_connect_reconciles_saved_state_and_allows_reassignment(
    monkeypatch, db_session
):
    registry = OperationRegistry()
    monkeypatch.setattr(managermodule, "operations", registry)

    @asynccontextmanager
    async def session():
        yield db_session

    monkeypatch.setattr(managermodule, "AsyncSessionLocal", session)
    manager = TrackerManager(tracker_id="target-1")
    manager._sync_tracker_context = AsyncMock()
    db_session.add(TrackingState(name=manager.tracking_state_name, value=dict(STATE)))
    await db_session.commit()
    command = request(registry, "connect", action="connect", changes={"rotator_state": "connected"})
    snapshot = {"tracking_state": {**STATE, "rotator_state": "disconnected"}}
    await manager.reconcile_operation(command, snapshot)
    assert (await manager.get_tracking_state())["rotator_state"] == "disconnected"
    assert snapshot["desired_state"]["rotator_state"] == "disconnected"
    registry.update("connect", "failed", "Connection refused")
    reply = await manager.update_tracking_state(
        rotator_id="replacement", operation={"command_id": "replace"}
    )
    assert reply["success"] is True


@pytest.mark.asyncio
async def test_late_worker_result_cannot_overwrite_newer_desired_state(monkeypatch, db_session):
    registry = OperationRegistry()
    monkeypatch.setattr(managermodule, "operations", registry)

    @asynccontextmanager
    async def session():
        yield db_session

    monkeypatch.setattr(managermodule, "AsyncSessionLocal", session)
    manager = TrackerManager(tracker_id="target-1")
    desired = {**STATE, "rotator_state": "stopped"}
    db_session.add(TrackingState(name=manager.tracking_state_name, value=desired))
    await db_session.commit()
    command = request(registry)
    registry.accept("target-1", {"rotator_state": "stopped"}, desired, {"action": "stop"})
    snapshot = {"tracking_state": {**STATE, "rotator_state": "disconnected"}}
    await manager.reconcile_operation(command, snapshot)
    assert (await manager.get_tracking_state())["rotator_state"] == "stopped"
    assert snapshot["desired_state"]["rotator_state"] == "stopped"
