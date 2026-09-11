import math
from datetime import datetime, timedelta, timezone

import pytest

from celestial import scene


@pytest.fixture(autouse=True)
def _block_external_io(monkeypatch):
    # Missing stubs must fail immediately, even when the application catches errors.
    def _unexpected_io(*_args, **_kwargs):
        pytest.fail("Sun scene unit tests must not access the database or Horizons API")

    monkeypatch.setattr(scene, "AsyncSessionLocal", _unexpected_io)
    monkeypatch.setattr(scene, "fetch_celestial_vectors", _unexpected_io)


class _DummyLogger:
    def debug(self, *_args, **_kwargs):
        return None

    def info(self, *_args, **_kwargs):
        return None

    def warning(self, *_args, **_kwargs):
        return None

    def error(self, *_args, **_kwargs):
        return None


@pytest.mark.asyncio
async def test_load_earth_observer_vectors_interpolates_to_scene_epoch(monkeypatch):
    epoch = datetime(2026, 6, 21, 10, 30, tzinfo=timezone.utc)
    sample_start = epoch - timedelta(hours=1)
    sample_end = epoch + timedelta(hours=1)

    async def _stub_vectors_snapshot(**_kwargs):
        return {
            "payload": {
                # The stored current vector belongs to a previous fetch, while
                # the orbit samples cover the scene's requested epoch.
                "position_xyz_au": [0.0, 0.0, 0.0],
                "orbit_samples_xyz_au": [[0.0, 0.0, 0.0], [2.0, 4.0, 6.0]],
                "orbit_sample_times_utc": [sample_start.isoformat(), sample_end.isoformat()],
            },
            "cache": "db-hit",
            "stale": False,
            "error": None,
        }

    monkeypatch.setattr(scene, "_get_vectors_snapshot", _stub_vectors_snapshot)

    position, samples = await scene._load_earth_observer_vectors(
        epoch=epoch,
        past_hours=1,
        future_hours=1,
        step_minutes=60,
        observer_location=None,
        force_refresh=False,
        allow_network_fetch=False,
        logger=_DummyLogger(),
    )

    assert position == [1.0, 2.0, 3.0]
    assert len(samples) == 2


@pytest.mark.asyncio
async def test_build_celestial_tracks_supports_sun_body_target(monkeypatch):
    async def _stub_observer_location():
        return {
            "id": "test-observer",
            "name": "Test",
            "lat": 40.5798912,
            "lon": 22.9670912,
            "alt_m": 0.0,
        }

    async def _stub_earth_observer_vectors(**_kwargs):
        # Sun coordinates need Earth's position even though the Sun is the origin.
        return [0.0, -1.0, 0.0], []

    monkeypatch.setattr(scene, "_load_observer_location", _stub_observer_location)
    monkeypatch.setattr(scene, "_load_earth_observer_vectors", _stub_earth_observer_vectors)

    payload = {
        "epoch": datetime(2026, 6, 21, 10, 0, tzinfo=timezone.utc).isoformat(),
        "past_hours": 1,
        "future_hours": 1,
        "step_minutes": 30,
        "celestial": [{"target_type": "body", "body_id": "sun", "name": "Sun"}],
    }

    # Target registration is persistence work outside this scene calculation test.
    result = await scene.build_celestial_tracks(
        data=payload, logger=_DummyLogger(), register_targets=False
    )

    assert result.get("success") is True
    data = result.get("data") or {}
    rows = data.get("celestial") or []
    assert len(rows) == 1

    row = rows[0]
    assert row.get("target_type") == "body"
    assert row.get("target_key") == "body:sun"
    assert row.get("body_id") == "sun"
    assert row.get("command") == "sun"
    assert row.get("source") == "horizons"
    assert row.get("cache")
    assert row.get("position_xyz_au") == [0.0, 0.0, 0.0]

    sky_position = row.get("sky_position") or {}
    assert math.isfinite(float(sky_position.get("az_deg")))
    assert math.isfinite(float(sky_position.get("el_deg")))

    observer_bodies = data.get("observer_bodies") or []
    assert len(observer_bodies) == 1
    assert observer_bodies[0].get("target_key") == "observer:sun"
    assert observer_bodies[0].get("target_type") == "observer"


@pytest.mark.asyncio
async def test_build_celestial_tracks_uses_synthetic_sun_origin_cache_only(monkeypatch):
    async def _stub_observer_location():
        return {
            "id": "test-observer",
            "name": "Test",
            "lat": 40.5798912,
            "lon": 22.9670912,
            "alt_m": 0.0,
        }

    async def _stub_earth_observer_vectors(**_kwargs):
        return [0.0, -1.0, 0.0], []

    monkeypatch.setattr(scene, "_load_observer_location", _stub_observer_location)
    monkeypatch.setattr(scene, "_load_earth_observer_vectors", _stub_earth_observer_vectors)

    payload = {
        "epoch": datetime(2026, 6, 21, 10, 0, tzinfo=timezone.utc).isoformat(),
        "past_hours": 1,
        "future_hours": 24,
        "step_minutes": 60,
        "celestial": [{"target_type": "body", "body_id": "sun", "name": "Sun"}],
    }

    result = await scene.build_celestial_tracks(
        data=payload,
        logger=_DummyLogger(),
        allow_network_fetch=False,
        register_targets=False,
    )

    assert result.get("success") is True
    row = ((result.get("data") or {}).get("celestial") or [])[0]
    assert row.get("target_key") == "body:sun"
    assert row.get("position_xyz_au") == [0.0, 0.0, 0.0]
    assert row.get("cache") == "scene-base-hit"

    sky_position = row.get("sky_position") or {}
    assert math.isfinite(float(sky_position.get("az_deg")))
    assert math.isfinite(float(sky_position.get("el_deg")))
