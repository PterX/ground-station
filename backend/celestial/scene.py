# Copyright (c) 2025 Efstratios Goudelis
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.

"""Scene builder for celestial page (offline planets + Horizons celestial)."""

from __future__ import annotations

import asyncio
import math
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import crud.locations as crud_locations
from celestial.asteroidzones import get_static_asteroid_zones
from celestial.horizons import fetch_celestial_observer_state, fetch_celestial_vectors
from celestial.solarsystem import compute_solar_system_snapshot
from db import AsyncSessionLocal

CACHE_TTL_SECONDS = 86400
MAX_SAMPLES_PER_TARGET = 1500
DEFAULT_CELESTIAL_TARGETS: List[Dict[str, str]] = []


@dataclass
class CacheEntry:
    payload: Dict[str, Any]
    fetched_at_monotonic: float


_celestial_cache: Dict[str, CacheEntry] = {}
_celestial_cache_lock = threading.Lock()


def _parse_epoch(data: Optional[Dict[str, Any]]) -> datetime:
    if not data:
        return datetime.now(timezone.utc)

    epoch_raw = data.get("epoch")
    if not epoch_raw:
        return datetime.now(timezone.utc)

    try:
        epoch_str = str(epoch_raw).strip()
        if epoch_str.endswith("Z"):
            epoch_str = epoch_str[:-1] + "+00:00"
        parsed = datetime.fromisoformat(epoch_str)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except Exception:
        return datetime.now(timezone.utc)


def _normalize_targets(data: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    if not data:
        return DEFAULT_CELESTIAL_TARGETS.copy()

    requested = data.get("celestial")
    if not requested:
        return DEFAULT_CELESTIAL_TARGETS.copy()

    normalized: List[Dict[str, Any]] = []

    for item in requested:
        if isinstance(item, str):
            command = item.strip()
            if command:
                normalized.append({"command": command, "name": command})
            continue

        if isinstance(item, dict):
            command = str(item.get("command") or item.get("id") or item.get("target") or "").strip()
            if not command:
                continue
            name = str(item.get("name") or command).strip()
            color = item.get("color")
            normalized.append({"command": command, "name": name, "color": color})

    return normalized


def _parse_projection_options(data: Optional[Dict[str, Any]]) -> Tuple[int, int, int]:
    if not data:
        return 24, 24, 60

    def parse_int(name: str, default: int, low: int, high: int) -> int:
        try:
            value = int(data.get(name, default))
        except (TypeError, ValueError):
            return default
        return max(low, min(high, value))

    past_hours = parse_int("past_hours", 24, 1, 24 * 365)
    future_hours = parse_int("future_hours", 24, 1, 24 * 365)
    step_minutes = parse_int("step_minutes", 60, 5, 24 * 60)
    adaptive_step_minutes = _compute_adaptive_step_minutes(
        past_hours=past_hours,
        future_hours=future_hours,
        requested_step_minutes=step_minutes,
        max_samples=MAX_SAMPLES_PER_TARGET,
    )
    return past_hours, future_hours, adaptive_step_minutes


def _round_up(value: int, base: int) -> int:
    if base <= 1:
        return max(1, value)
    return int(math.ceil(value / base) * base)


def _compute_adaptive_step_minutes(
    past_hours: int,
    future_hours: int,
    requested_step_minutes: int,
    max_samples: int,
) -> int:
    span_hours = max(1, int(past_hours) + int(future_hours))

    # Increase minimum resolution progressively as window span grows.
    if span_hours <= 72:
        min_step_for_span = 30
    elif span_hours <= 14 * 24:
        min_step_for_span = 60
    elif span_hours <= 60 * 24:
        min_step_for_span = 180
    elif span_hours <= 180 * 24:
        min_step_for_span = 360
    else:
        min_step_for_span = 720

    effective_step = max(int(requested_step_minutes), min_step_for_span)

    # Enforce hard sample cap per target by raising step if needed.
    span_minutes = span_hours * 60
    estimated_samples = int(span_minutes / effective_step) + 1
    if estimated_samples > max_samples:
        required_step = _round_up(
            int(math.ceil(span_minutes / max(1, max_samples - 1))),
            5,
        )
        effective_step = max(effective_step, required_step)

    return min(max(5, effective_step), 24 * 60)


async def _load_observer_location() -> Optional[Dict[str, Any]]:
    """Load the first configured ground-station location for observer sky coordinates."""
    async with AsyncSessionLocal() as dbsession:
        result = await crud_locations.fetch_all_locations(dbsession)

    rows_obj = result.get("data") if isinstance(result, dict) else None
    rows = rows_obj if isinstance(rows_obj, list) else []
    if not rows:
        return None

    first = rows[0]
    try:
        lat = float(first.get("lat"))
        lon = float(first.get("lon"))
        alt_m = float(first.get("alt") or 0.0)
    except (TypeError, ValueError):
        return None

    return {
        "id": first.get("id"),
        "name": first.get("name"),
        "lat": lat,
        "lon": lon,
        "alt_m": alt_m,
    }


async def _attach_observer_view(
    row: Dict[str, Any],
    command: str,
    epoch: datetime,
    observer_location: Optional[Dict[str, Any]],
    logger: Any,
) -> None:
    """Attach observer-centric sky position and visibility metadata to one celestial row."""
    if not observer_location:
        row["sky_position"] = None
        row["visibility"] = {
            "above_horizon": None,
            "visible": None,
            "horizon_threshold_deg": 0.0,
        }
        return

    try:
        observer_view = await asyncio.to_thread(
            fetch_celestial_observer_state,
            command,
            epoch,
            float(observer_location["lat"]),
            float(observer_location["lon"]),
            float(observer_location.get("alt_m", 0.0)) / 1000.0,
        )
        row["sky_position"] = observer_view.get("sky_position")
        row["visibility"] = observer_view.get("visibility")
    except Exception as exc:
        logger.warning(f"Horizons observer fetch failed for celestial '{command}': {exc}")
        row["sky_position"] = None
        row["visibility"] = {
            "above_horizon": None,
            "visible": None,
            "horizon_threshold_deg": 0.0,
            "error": str(exc),
        }


async def _fetch_celestial_with_cache(
    targets: List[Dict[str, Any]],
    epoch: datetime,
    past_hours: int,
    future_hours: int,
    step_minutes: int,
    observer_location: Optional[Dict[str, Any]],
    force_refresh: bool,
    logger,
) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    now_monotonic = time.monotonic()

    for target in targets:
        command = target["command"]
        name = target["name"]
        color = target.get("color")
        observer_cache_key = "no-observer"
        if observer_location:
            observer_cache_key = (
                f"{observer_location.get('id')}"
                f"|{observer_location.get('lat')}"
                f"|{observer_location.get('lon')}"
                f"|{observer_location.get('alt_m')}"
            )
        cache_key = (
            f"{command}|p{past_hours}|f{future_hours}|s{step_minutes}|obs:{observer_cache_key}"
        )

        use_cached = False
        cached_entry: Optional[CacheEntry] = None

        with _celestial_cache_lock:
            cached_entry = _celestial_cache.get(cache_key)
            if (
                cached_entry
                and not force_refresh
                and now_monotonic - cached_entry.fetched_at_monotonic <= CACHE_TTL_SECONDS
            ):
                use_cached = True

        if use_cached and cached_entry:
            cached_payload = dict(cached_entry.payload)
            cached_payload["name"] = name
            cached_payload["color"] = color
            cached_payload["stale"] = False
            cached_payload["cache"] = "hit"
            await _attach_observer_view(
                cached_payload,
                command=command,
                epoch=epoch,
                observer_location=observer_location,
                logger=logger,
            )
            rows.append(cached_payload)
            continue

        try:
            fetched = await asyncio.to_thread(
                fetch_celestial_vectors,
                command,
                epoch,
                past_hours,
                future_hours,
                step_minutes,
            )
            fetched["name"] = name
            fetched["color"] = color
            fetched["stale"] = False
            fetched["cache"] = "miss"

            await _attach_observer_view(
                fetched,
                command=command,
                epoch=epoch,
                observer_location=observer_location,
                logger=logger,
            )

            with _celestial_cache_lock:
                _celestial_cache[cache_key] = CacheEntry(
                    payload={
                        key: value
                        for key, value in fetched.items()
                        if key not in {"sky_position", "visibility"}
                    },
                    fetched_at_monotonic=time.monotonic(),
                )

            rows.append(fetched)
        except Exception as exc:
            logger.warning(f"Horizons fetch failed for celestial '{command}': {exc}")

            fallback_payload: Optional[Dict[str, Any]] = None
            with _celestial_cache_lock:
                cached_entry = _celestial_cache.get(cache_key)
                if cached_entry:
                    fallback_payload = dict(cached_entry.payload)

            if fallback_payload:
                fallback_payload["name"] = name
                fallback_payload["color"] = color
                fallback_payload["stale"] = True
                fallback_payload["cache"] = "stale"
                fallback_payload["error"] = str(exc)
                fallback_payload["sky_position"] = None
                fallback_payload["visibility"] = {
                    "above_horizon": None,
                    "visible": None,
                    "horizon_threshold_deg": 0.0,
                }
                rows.append(fallback_payload)
            else:
                error_row = {
                    "name": name,
                    "command": command,
                    "color": color,
                    "source": "horizons",
                    "stale": True,
                    "error": str(exc),
                    "sky_position": None,
                    "visibility": {
                        "above_horizon": None,
                        "visible": None,
                        "horizon_threshold_deg": 0.0,
                    },
                }
                rows.append(error_row)

    return rows


async def build_celestial_scene(
    data: Optional[Dict[str, Any]],
    logger,
    force_refresh: bool = False,
) -> Dict[str, Any]:
    """Build a scene payload for UI rendering and backend sharing."""
    epoch = _parse_epoch(data)
    targets = _normalize_targets(data)
    past_hours, future_hours, step_minutes = _parse_projection_options(data)
    observer_location = await _load_observer_location()

    solar_meta, planets = compute_solar_system_snapshot(epoch)
    asteroid_zones, asteroid_resonance_gaps, asteroid_meta = get_static_asteroid_zones()
    celestial = await _fetch_celestial_with_cache(
        targets,
        epoch,
        past_hours,
        future_hours,
        step_minutes,
        observer_location,
        force_refresh,
        logger,
    )

    return {
        "success": True,
        "data": {
            "timestamp_utc": epoch.isoformat(),
            "frame": "heliocentric-ecliptic",
            "center": "sun",
            "units": {
                "position": "au",
                "velocity": "au/day",
            },
            "planets": planets,
            "celestial": celestial,
            "asteroid_zones": asteroid_zones,
            "asteroid_resonance_gaps": asteroid_resonance_gaps,
            "meta": {
                "solar_system": solar_meta,
                "celestial_source": "horizons",
                "asteroid_zones": asteroid_meta,
                "cache_ttl_seconds": CACHE_TTL_SECONDS,
                "projection": {
                    "past_hours": past_hours,
                    "future_hours": future_hours,
                    "step_minutes": step_minutes,
                },
                "observer_location": observer_location,
                "visibility_definition": "visible == elevation_deg > 0",
            },
        },
    }


async def build_solar_system_scene(
    data: Optional[Dict[str, Any]],
    logger,
) -> Dict[str, Any]:
    """Build only the offline solar system portion for fast initial render."""
    epoch = _parse_epoch(data)
    past_hours, future_hours, step_minutes = _parse_projection_options(data)
    solar_meta, planets = compute_solar_system_snapshot(epoch)
    asteroid_zones, asteroid_resonance_gaps, asteroid_meta = get_static_asteroid_zones()

    return {
        "success": True,
        "data": {
            "timestamp_utc": epoch.isoformat(),
            "frame": "heliocentric-ecliptic",
            "center": "sun",
            "units": {
                "position": "au",
                "velocity": "au/day",
            },
            "planets": planets,
            "asteroid_zones": asteroid_zones,
            "asteroid_resonance_gaps": asteroid_resonance_gaps,
            "meta": {
                "solar_system": solar_meta,
                "asteroid_zones": asteroid_meta,
                "projection": {
                    "past_hours": past_hours,
                    "future_hours": future_hours,
                    "step_minutes": step_minutes,
                },
            },
        },
    }


async def build_celestial_tracks(
    data: Optional[Dict[str, Any]],
    logger,
    force_refresh: bool = False,
) -> Dict[str, Any]:
    """Build only Horizons-backed tracked celestial objects."""
    epoch = _parse_epoch(data)
    targets = _normalize_targets(data)
    past_hours, future_hours, step_minutes = _parse_projection_options(data)
    observer_location = await _load_observer_location()
    celestial = await _fetch_celestial_with_cache(
        targets,
        epoch,
        past_hours,
        future_hours,
        step_minutes,
        observer_location,
        force_refresh,
        logger,
    )

    return {
        "success": True,
        "data": {
            "timestamp_utc": epoch.isoformat(),
            "frame": "heliocentric-ecliptic",
            "center": "sun",
            "units": {
                "position": "au",
                "velocity": "au/day",
            },
            "celestial": celestial,
            "meta": {
                "celestial_source": "horizons",
                "cache_ttl_seconds": CACHE_TTL_SECONDS,
                "projection": {
                    "past_hours": past_hours,
                    "future_hours": future_hours,
                    "step_minutes": step_minutes,
                },
                "observer_location": observer_location,
                "visibility_definition": "visible == elevation_deg > 0",
            },
        },
    }
