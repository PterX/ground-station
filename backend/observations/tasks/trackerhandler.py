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

"""Tracker task handler - manages rotator tracking lifecycle."""

import asyncio
import traceback
from typing import Any, Dict, List, Optional

from common.logger import logger
from tracker.instances import emit_tracker_instances
from tracker.runner import (
    ensure_tracker_for_rotator,
    get_assigned_tracker_for_rotator,
    get_tracker_manager,
)
from tracker.stateupdate import update_tracking_state_with_ownership


class TrackerHandler:
    """Handles rotator tracking lifecycle for observations."""

    def __init__(self, sio: Optional[Any] = None):
        self.sio = sio

    async def _emit_tracker_instances_snapshot(self) -> None:
        if self.sio is None:
            return
        try:
            await emit_tracker_instances(self.sio)
        except Exception as exc:
            logger.warning("Failed to emit tracker instance snapshot: %s", exc)

    @staticmethod
    def _resolve_tracker_id(rotator_config: Dict[str, Any]) -> str:
        owner_tracker_id = get_assigned_tracker_for_rotator(rotator_config.get("id"))
        if owner_tracker_id is None:
            return ""
        tracker_id = str(owner_tracker_id).strip()
        if not tracker_id or tracker_id.lower() == "none":
            return ""
        return tracker_id

    async def start_tracker_task(
        self,
        observation_id: str,
        satellite: Dict[str, Any],
        rotator_config: Dict[str, Any],
        tasks: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """
        Start rotator tracking for an observation.

        Args:
            observation_id: The observation ID
            satellite: Satellite information dict
            rotator_config: Rotator configuration dict
            tasks: List of observation tasks

        Returns:
            Dictionary with success/failure metadata
        """
        try:
            if not rotator_config.get("tracking_enabled") or not rotator_config.get("id"):
                logger.debug(f"Rotator tracking not enabled for observation {observation_id}")
                return {"success": True, "skipped": True, "reason": "tracking_disabled"}

            # Extract transmitter ID from decoder tasks (if any)
            transmitter_id = "none"
            for task in tasks:
                if task.get("type") == "decoder":
                    transmitter_id = task.get("config", {}).get("transmitter_id", "none")
                    break

            # Update tracking state to target this satellite
            tracker_resolution = ensure_tracker_for_rotator(rotator_config.get("id"))
            if not tracker_resolution.get("success"):
                return {
                    "success": False,
                    "error": tracker_resolution.get("error", "tracker_resolution_failed"),
                    "message": (
                        tracker_resolution.get("message")
                        or "Failed to resolve tracker for selected rotator."
                    ),
                }
            tracker_id = str(tracker_resolution.get("tracker_id"))
            if tracker_resolution.get("created"):
                logger.info(
                    "Created tracker slot %s for rotator %s (observation %s)",
                    tracker_id,
                    rotator_config.get("id"),
                    observation_id,
                )
            tracker_manager = get_tracker_manager(tracker_id)
            unpark_before_tracking = bool(rotator_config.get("unpark_before_tracking", False))
            tracking_state = await tracker_manager.get_tracking_state() or {}
            current_rotator_state = str(tracking_state.get("rotator_state", "")).lower()

            # Optional unpark step before switching to tracking mode.
            if current_rotator_state == "parked" and unpark_before_tracking:
                unpark_reply: Dict[str, Any] = await update_tracking_state_with_ownership(
                    tracker_id=tracker_id,
                    value={
                        "rotator_state": "connected",
                        "rotator_id": rotator_config.get("id"),
                    },
                    requester_sid=f"observation:{observation_id}",
                )
                if not unpark_reply.get("success"):
                    return unpark_reply
                await asyncio.sleep(0.2)

            tracking_reply: Dict[str, Any] = await update_tracking_state_with_ownership(
                tracker_id=tracker_id,
                value={
                    "norad_id": satellite.get("norad_id"),
                    "group_id": satellite.get("group_id"),
                    "rotator_state": "tracking",  # Start tracking satellite
                    "rotator_id": rotator_config.get("id"),
                    "rig_state": "disconnected",  # Observations don't use rig for now
                    "rig_id": "none",
                    "transmitter_id": transmitter_id,
                    "rig_vfo": "none",
                    "vfo1": "uplink",
                    "vfo2": "downlink",
                },
                requester_sid=f"observation:{observation_id}",
            )
            if not tracking_reply.get("success"):
                return tracking_reply

            await self._emit_tracker_instances_snapshot()

            logger.info(
                f"Started tracking {satellite.get('name')} (NORAD {satellite.get('norad_id')}) "
                f"for observation {observation_id}"
            )
            return {"success": True}

        except Exception as e:
            logger.error(f"Error starting tracker: {e}")
            logger.error(traceback.format_exc())
            return {
                "success": False,
                "error": "tracker_start_failed",
                "message": str(e),
            }

    async def stop_tracker_task(self, observation_id: str, rotator_config: Dict[str, Any]) -> bool:
        """
        Stop rotator tracking for an observation.

        Args:
            observation_id: The observation ID
            rotator_config: Rotator configuration dict

        Returns:
            True if tracker stop/park operations succeeded
        """
        try:
            if not rotator_config.get("tracking_enabled") or not rotator_config.get("id"):
                logger.debug(f"No rotator configured for observation {observation_id}")
                return True

            tracker_id = self._resolve_tracker_id(rotator_config)
            if not tracker_id:
                logger.debug(
                    "Skipping tracker stop for observation %s: no tracker currently assigned to rotator %s",
                    observation_id,
                    rotator_config.get("id"),
                )
                return True
            park_after_observation = bool(rotator_config.get("park_after_observation", False))

            if park_after_observation:
                park_reply = await update_tracking_state_with_ownership(
                    tracker_id=tracker_id,
                    value={
                        "rotator_state": "parked",
                        "rotator_id": rotator_config.get("id"),
                    },
                    requester_sid=f"observation:{observation_id}",
                )
                if not park_reply.get("success"):
                    logger.warning(
                        "Failed to park rotator for observation %s: %s",
                        observation_id,
                        park_reply,
                    )
                    return False
                logger.info(f"Parked rotator after observation {observation_id}")
            else:
                logger.debug(f"Leaving rotator connected after observation {observation_id}")

            return True
        except Exception as e:
            logger.error(f"Error stopping tracker for observation {observation_id}: {e}")
            logger.error(traceback.format_exc())
            return False
