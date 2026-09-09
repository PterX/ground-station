# Copyright (c) 2026 Efstratios Goudelis

import pytest

from handlers.entities import hardware


@pytest.mark.asyncio
async def test_move_rotator_rejects_non_finite_coordinates():
    result = await hardware.move_rotator(
        None,
        {"tracker_id": "target-1", "az": "nan", "el": 45},
        None,
        "sid",
    )

    assert result["success"] is False
    assert result["error"] == "invalid_rotator_position"


@pytest.mark.asyncio
async def test_move_rotator_rejects_active_automatic_tracking(monkeypatch):
    class _Manager:
        async def get_tracking_state(self):
            return {"rotator_state": "tracking", "rotator_id": "rotator-1"}

    monkeypatch.setattr(hardware, "get_existing_tracker_manager", lambda tracker_id: _Manager())
    monkeypatch.setattr(
        hardware,
        "get_tracker_instances_payload",
        lambda: {"instances": [{"tracker_id": "target-1", "is_alive": True}]},
    )

    result = await hardware.move_rotator(
        None,
        {"tracker_id": "target-1", "az": 180, "el": 45},
        None,
        "sid",
    )

    assert result["success"] is False
    assert result["error"] == "rotator_is_tracking"


@pytest.mark.asyncio
async def test_move_rotator_rejects_parked_rotator(monkeypatch):
    class _Manager:
        async def get_tracking_state(self):
            return {"rotator_state": "parked", "rotator_id": "rotator-1"}

    monkeypatch.setattr(hardware, "get_existing_tracker_manager", lambda tracker_id: _Manager())
    monkeypatch.setattr(
        hardware,
        "get_tracker_instances_payload",
        lambda: {"instances": [{"tracker_id": "target-1", "is_alive": True}]},
    )

    result = await hardware.move_rotator(
        None,
        {"tracker_id": "target-1", "az": 180, "el": 45},
        None,
        "sid",
    )

    assert result["success"] is False
    assert result["error"] == "rotator_is_parked"


@pytest.mark.asyncio
async def test_move_rotator_limits_overlap_rotators_to_360_degrees(monkeypatch):
    class _Manager:
        def __init__(self):
            self.commands = []

        async def get_tracking_state(self):
            return {"rotator_state": "stopped", "rotator_id": "rotator-1"}

        def send_command(self, command, data):
            self.commands.append((command, data))

    class _SessionContext:
        async def __aenter__(self):
            return object()

        async def __aexit__(self, exc_type, exc_value, traceback):
            return False

    async def _fetch_rotator(session, rotator_id):
        return {
            "success": True,
            "data": {
                "azimuth_mode": "0_450",
                "minaz": 0,
                "maxaz": 450,
                "minel": 0,
                "maxel": 90,
            },
        }

    manager = _Manager()
    monkeypatch.setattr(hardware, "get_existing_tracker_manager", lambda tracker_id: manager)
    monkeypatch.setattr(
        hardware,
        "get_tracker_instances_payload",
        lambda: {"instances": [{"tracker_id": "target-1", "is_alive": True}]},
    )
    monkeypatch.setattr(hardware, "AsyncSessionLocal", _SessionContext)
    monkeypatch.setattr(hardware.crud.hardware, "fetch_rotators", _fetch_rotator)

    allowed = await hardware.move_rotator(
        None,
        {"tracker_id": "target-1", "az": 360, "el": 45},
        None,
        "sid",
    )
    rejected = await hardware.move_rotator(
        None,
        {"tracker_id": "target-1", "az": 360.1, "el": 45},
        None,
        "sid",
    )

    assert allowed["success"] is True
    assert manager.commands == [("move_to_position", {"az": 360.0, "el": 45.0})]
    assert rejected["success"] is False
    assert rejected["error"] == "rotator_position_out_of_bounds"
    assert rejected["data"]["maxaz"] == 360
