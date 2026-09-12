# Copyright (c) 2026 Efstratios Goudelis

from types import SimpleNamespace

import pytest
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from common import auth, timezones
from crud import preferences
from db.models import Locations, Preferences, PreferenceScope
from handlers.entities import locations, setup


@pytest.fixture
def auth_session(db_engine, monkeypatch):
    maker = async_sessionmaker(db_engine, class_=AsyncSession, expire_on_commit=False)
    monkeypatch.setattr(auth, "AsyncSessionLocal", maker)
    return maker


@pytest.mark.parametrize(
    "lat, lon, expected",
    [
        (52.3676, 4.9041, "Europe/Amsterdam"),
        (40.7128, -74.006, "America/New_York"),
        (27.7172, 85.3240, "Asia/Kathmandu"),
        (-34.9285, 138.6007, "Australia/Adelaide"),
    ],
)
async def test_preview_and_setup_use_same_coordinate_timezone(lat, lon, expected):
    preview = await locations.get_location_timezone(None, {"lat": lat, "lon": lon}, None, "sid")
    payload = setup._normalize_finalize_payload(
        {
            "location": {"lat": lat, "lon": lon},
            "admin": {"username": "admin", "password": "password123"},
        }
    )
    assert preview == {"success": True, "data": {"timezone": expected}}
    assert payload["timezone"] == expected


@pytest.mark.parametrize(
    "data",
    [
        None,
        {},
        {"lat": 91, "lon": 0},
        {"lat": 0, "lon": -181},
        {"lat": "NaN", "lon": 0},
        {"lat": 0, "lon": float("inf")},
        {"lat": True, "lon": 0},
        {"lat": [], "lon": 0},
    ],
)
async def test_preview_rejects_invalid_coordinates(data):
    reply = await locations.get_location_timezone(None, data, None, "sid")
    assert reply["success"] is False


def test_timezone_lookup_falls_back_to_utc(monkeypatch):
    monkeypatch.setattr(
        timezones, "_timezone_finder", SimpleNamespace(timezone_at=lambda **_: None)
    )
    assert timezones.timezone_for_coordinates(0, 0) == "UTC"


@pytest.mark.parametrize("value", [None, "", "UTC+1", "Europe/Missing", "../etc/passwd", 3])
def test_setup_rejects_invalid_timezone_selection(value):
    with pytest.raises(ValueError, match="IANA timezone"):
        setup._normalize_finalize_payload(
            {
                "location": {"lat": 52.3676, "lon": 4.9041},
                "admin": {"username": "admin", "password": "password123"},
                "timezone": value,
            }
        )


def test_timezone_preview_is_available_during_setup():
    assert auth.is_command_allowed_during_setup("get-location-timezone")
    assert auth.is_command_allowed_for_role("get-location-timezone", "operator")


@pytest.mark.parametrize(
    "selection, expected", [(None, "Europe/Athens"), ("Asia/Kathmandu", "Asia/Kathmandu")]
)
async def test_bootstrap_keeps_legacy_timezone_unless_explicitly_selected(
    auth_session, selection, expected
):
    async with auth_session() as session:
        session.add(
            Preferences(
                scope=PreferenceScope.BOOTSTRAP.value, name="timezone", value="Europe/Athens"
            )
        )
        await session.commit()
    result = await auth.bootstrap_admin(
        "admin", "password123", initial_preferences={"timezone": selection} if selection else None
    )
    assert result["success"]
    async with auth_session() as session:
        reply = await preferences.fetch_user_preferences(session, result["user"]["id"])
    assert next(row["value"] for row in reply["data"] if row["name"] == "timezone") == expected


async def test_additional_account_saves_station_timezone_independently_of_admin(auth_session):
    async with auth_session() as session:
        station = Locations(name="home", lat=52.3676, lon=4.9041, alt=0)
        session.add(station)
        await session.commit()
    admin = await auth.bootstrap_admin(
        "admin", "password123", initial_preferences={"timezone": "UTC"}
    )
    assert admin["success"]
    account = await auth.create_user("operator", "password123", "operator")
    assert account["success"]
    async with auth_session() as session:
        reply = await preferences.fetch_user_preferences(session, account["data"]["id"])
        zone = next(row for row in reply["data"] if row["name"] == "timezone")
        assert zone["value"] == "Europe/Amsterdam"
        assert zone["id"] is not None  # The default is saved, not recalculated on each login.
        station.lat, station.lon = 27.7172, 85.3240
        await session.merge(station)
        await session.commit()
    async with auth_session() as session:
        reply = await preferences.fetch_user_preferences(session, account["data"]["id"])
    assert (
        next(row["value"] for row in reply["data"] if row["name"] == "timezone")
        == "Europe/Amsterdam"
    )


async def test_additional_account_without_station_uses_utc(auth_session):
    result = await auth.create_user("operator", "password123", "operator")
    assert result["success"]
    async with auth_session() as session:
        reply = await preferences.fetch_user_preferences(session, result["data"]["id"])
    assert next(row["value"] for row in reply["data"] if row["name"] == "timezone") == "UTC"


async def test_account_without_saved_timezone_defaults_to_station(auth_session):
    result = await auth.create_user("operator", "password123", "operator")
    assert result["success"]
    async with auth_session() as session:
        # Older additional accounts may never have saved any preferences.
        await session.execute(delete(Preferences).where(Preferences.name == "timezone"))
        session.add(Locations(name="home", lat=52.3676, lon=4.9041, alt=0))
        await session.commit()
        reply = await preferences.fetch_user_preferences(session, result["data"]["id"])
    zone = next(row for row in reply["data"] if row["name"] == "timezone")
    assert zone["value"] == "Europe/Amsterdam"
    assert zone["id"] is None


async def test_saved_athens_preference_is_preserved_after_upgrade(auth_session):
    result = await auth.bootstrap_admin(
        "admin", "password123", initial_preferences={"timezone": "Europe/Athens"}
    )
    async with auth_session() as session:
        session.add(Locations(name="home", lat=52.3676, lon=4.9041, alt=0))
        await session.commit()
        reply = await preferences.fetch_user_preferences(session, result["user"]["id"])
    assert (
        next(row["value"] for row in reply["data"] if row["name"] == "timezone") == "Europe/Athens"
    )
