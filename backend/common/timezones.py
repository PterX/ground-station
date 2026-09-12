# Copyright (c) 2026 Efstratios Goudelis

"""Shared timezone resolution for station setup and account defaults."""

from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from timezonefinder import TimezoneFinder

from db.models import Locations

# Boundary data is bundled with the package; lookup requires no external service.
_timezone_finder = TimezoneFinder()


def normalize_coordinates(latitude: object, longitude: object) -> tuple[float, float]:
    if latitude is None or longitude is None:
        raise ValueError("Latitude and longitude are required.")
    if (
        isinstance(latitude, bool)
        or isinstance(longitude, bool)
        or not isinstance(latitude, (str, int, float))
        or not isinstance(longitude, (str, int, float))
    ):
        raise ValueError("Latitude and longitude must be valid numbers.")
    try:
        lat = float(latitude)
        lon = float(longitude)
    except (TypeError, ValueError) as exc:
        raise ValueError("Latitude and longitude must be valid numbers.") from exc
    # These bounds also reject NaN and infinity.
    if not (-90.0 <= lat <= 90.0):
        raise ValueError("Latitude must be between -90 and 90.")
    if not (-180.0 <= lon <= 180.0):
        raise ValueError("Longitude must be between -180 and 180.")
    return lat, lon


def timezone_for_coordinates(latitude: object, longitude: object) -> str:
    lat, lon = normalize_coordinates(latitude, longitude)
    return _timezone_finder.timezone_at(lat=lat, lng=lon) or "UTC"


def validate_timezone(value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("Timezone must be a valid IANA timezone name.")
    name = value.strip()
    try:
        ZoneInfo(name)
    except (ValueError, ZoneInfoNotFoundError) as exc:
        raise ValueError("Timezone must be a valid IANA timezone name.") from exc
    return name


async def station_timezone(session: AsyncSession) -> str:
    # Match fetch_all_locations: the most recently updated location is active.
    location = (
        await session.execute(
            select(Locations).order_by(Locations.updated.desc(), Locations.added.desc()).limit(1)
        )
    ).scalar_one_or_none()
    if location is None:
        return "UTC"
    return timezone_for_coordinates(location.lat, location.lon)
