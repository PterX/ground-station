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


import asyncio
import logging
import multiprocessing
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import psutil

from common.arguments import arguments as args
from common.constants import DictKeys, SocketEvents
from tracker.data import compiled_satellite_data_from_inputs
from tracker.ipc import (
    TRACKER_MSG_COMMAND,
    TRACKER_MSG_SET_HARDWARE,
    TRACKER_MSG_SET_LOCATION,
    TRACKER_MSG_SET_MAP_SETTINGS,
    TRACKER_MSG_SET_SATELLITE_EPHEMERIS,
    TRACKER_MSG_SET_TRACKING_STATE,
    TRACKER_MSG_SET_TRANSMITTERS,
)
from tracker.righandler import RigHandler
from tracker.rotatorhandler import RotatorHandler
from tracker.statemanager import StateManager

logger = logging.getLogger("tracker-worker")


class SatelliteTracker:
    """
    Satellite tracking class that manages rotator and rig controllers
    for automated satellite tracking in a multiprocessing environment.
    """

    def __init__(
        self, queue_out: multiprocessing.Queue, queue_in: multiprocessing.Queue, stop_event=None
    ):
        """Initialize the satellite tracker with queues and configuration."""
        # Store queue references
        self.rotator_details: Dict[str, Any] = {}
        self.rig_details: Dict[str, Any] = {}
        self.queue_out = queue_out
        self.queue_in = queue_in
        self.stop_event = stop_event

        # Configuration constants (will be updated from rotator_details)
        self.azimuth_limits = (0, 360)
        self.elevation_limits = (0, 90)
        self.az_tolerance = 2.0
        self.el_tolerance = 2.0

        # State tracking
        self.current_rotator_id = "none"
        self.current_rig_id = "none"
        self.current_transmitter_id = "none"
        self.current_rig_vfo = "none"
        self.current_vfo1 = "uplink"
        self.current_vfo2 = "downlink"
        self.current_rotator_state = "disconnected"
        self.current_rig_state = "disconnected"
        self.current_norad_id = None
        self.current_group_id = None

        # Hardware controllers
        self.rotator_controller = None
        self.rig_controller = None

        # Data structures
        self.rotator_data = {
            "az": 0,
            "el": 0,
            "connected": False,
            "tracking": False,
            "slewing": False,
            "outofbounds": False,
            "minelevation": False,
            "maxelevation": False,
            "minazimuth": False,
            "maxazimuth": False,
            "stopped": False,
            "error": False,
            "host": "",
            "port": 0,
            "minaz": None,
            "maxaz": None,
            "minel": None,
            "maxel": None,
        }
        self.rig_data = {
            "connected": False,
            "tracking": False,
            "stopped": False,
            "error": False,
            "frequency": 0,
            "downlink_observed_freq": 0,
            "doppler_shift": 0,
            "original_freq": 0,
            "transmitter_id": "none",
            "transmitters": [],
            "device_type": "",
            "host": "",
            "port": 0,
            "radio_mode": "duplex",
            "tx_control_mode": "auto",
            "active_tx_control_mode": "vfo_switch",
            "retune_interval_ms": 2000,
            "follow_downlink_tuning": False,
            "operator_downlink_offset_hz": 0,
            "vfo1": {
                "frequency": 0,
                "mode": "UNKNOWN",
                "bandwidth": 0,
            },
            "vfo2": {
                "frequency": 0,
                "mode": "UNKNOWN",
                "bandwidth": 0,
            },
        }

        # Operational state
        self.notified: Dict[str, bool] = {}
        self.nudge_offset = {"az": 0, "el": 0}
        self.rotator_command_state: Dict[str, Any] = {
            "in_flight": False,
            "target_az": None,
            "target_el": None,
            "last_command_ts": 0.0,
            "settle_hits": 0,
        }
        self.rotator_retarget_threshold_deg = 2.0
        self.rotator_command_refresh_sec = 6.0
        self.rotator_settle_hits_required = 2

        # Satellite data
        self.satellite_data: Dict[str, Any] = {}

        # State change tracking (replacing StateTracker)
        self.prev_norad_id: Optional[int] = None
        self.prev_rotator_state: Optional[str] = None
        self.prev_rotator_id: Optional[str] = None
        self.prev_rig_state: Optional[str] = None
        self.prev_transmitter_id: Optional[str] = None
        self.prev_rig_id: Optional[str] = None

        # Events to send the UI
        self.events: List[Dict[str, Any]] = []

        # Performance monitoring
        self.start_loop_date: Optional[datetime] = None

        # Stats tracking
        self.stats: Dict[str, Any] = {
            "updates_sent": 0,
            "commands_processed": 0,
            "db_queries": 0,
            "tracking_cycles": 0,
            "rotator_updates": 0,
            "rig_updates": 0,
            "last_activity": None,
            "errors": 0,
            "cpu_percent": 0.0,
            "memory_mb": 0.0,
            "memory_percent": 0.0,
        }
        self.last_stats_send = time.time()
        self.stats_send_interval = 1.0

        # CPU and memory monitoring
        self.process = psutil.Process()
        self.last_cpu_check = time.time()
        self.cpu_check_interval = 0.5

        # Initialize handlers
        self.rotator_handler = RotatorHandler(self)
        self.rig_handler = RigHandler(self)
        self.state_manager = StateManager(self)

        # Inputs provided by manager via IPC
        self.input_tracking_state: Optional[Dict[str, Any]] = None
        self.input_location: Optional[Dict[str, Any]] = None
        self.input_transmitters: List[Dict[str, Any]] = []
        self.input_satellite: Optional[Dict[str, Any]] = None
        self.input_map_settings: Dict[str, Any] = {}
        self.input_hardware: Dict[str, Any] = {}

    def in_tracking_state(self) -> bool:
        """Check if rotator is currently in tracking state."""
        return self.current_rotator_state == "tracking"

    async def run(self):
        """Main tracking loop."""
        # Validate interval
        assert (
            0 < args.track_interval_ms < 6000
        ), f"track_interval_ms must be between 1 and 5999, got {args.track_interval_ms}"

        interval_seconds = args.track_interval_ms / 1000.0

        tracker: Dict[str, Any] = {}

        logger.info(
            "Tracker process started (pid=%s, interval=%ss)",
            self.process.pid,
            interval_seconds,
        )
        while True:
            # Update CPU and memory usage periodically
            current_time = time.time()
            if current_time - self.last_cpu_check >= self.cpu_check_interval:
                try:
                    cpu_percent = self.process.cpu_percent()
                    mem_info = self.process.memory_info()
                    memory_mb = mem_info.rss / (1024 * 1024)
                    memory_percent = self.process.memory_percent()
                    self.stats["cpu_percent"] = cpu_percent
                    self.stats["memory_mb"] = memory_mb
                    self.stats["memory_percent"] = memory_percent
                    self.last_cpu_check = current_time
                except Exception:
                    pass

            # Send stats periodically via queue_out
            if current_time - self.last_stats_send >= self.stats_send_interval:
                self.queue_out.put(
                    {
                        "type": "stats",
                        "tracker_id": "satellite_tracker",
                        "stats": self.stats.copy(),
                        "timestamp": current_time,
                    }
                )
                self.last_stats_send = current_time

            # Process commands first
            should_stop = await self.state_manager.process_commands()
            if should_stop:
                break

            # Initialize to None at the start of each iteration
            initial_tracking_state = None

            try:
                self.stats["tracking_cycles"] += 1
                self.stats["last_activity"] = time.time()
                self.start_loop_date = datetime.now(timezone.utc)
                self.events = []

                tracking_state = self.input_tracking_state
                if not tracking_state:
                    continue

                initial_tracking_state = dict(tracking_state)

                if not tracking_state.get("norad_id"):
                    logger.warning(
                        "No norad id found in satellite tracking state, skipping iteration"
                    )
                    continue

                if not self.input_location:
                    logger.warning("No location provided to tracker, skipping iteration")
                    continue
                location = self.input_location

                if not self.input_satellite or self.input_satellite.get(
                    "norad_id"
                ) != tracking_state.get("norad_id"):
                    logger.warning("No matching satellite ephemeris provided, skipping iteration")
                    continue

                tracker = tracking_state

                # Get a data dict that contains all the information for the target satellite
                self.satellite_data = compiled_satellite_data_from_inputs(
                    self.input_satellite,
                    self.input_location,
                    self.input_transmitters,
                    self.input_map_settings,
                )
                assert not self.satellite_data["error"], (
                    f"Could not compute satellite details for satellite "
                    f"{tracking_state.get('norad_id')}"
                )

                satellite_tles = [
                    self.input_satellite["tle1"],
                    self.input_satellite["tle2"],
                ]
                satellite_name = self.input_satellite["name"]

                # Update current state variables
                self.current_norad_id = tracker.get("norad_id", None)
                self.current_group_id = tracker.get("group_id", None)
                self.current_rotator_id = tracker.get("rotator_id", "none")
                self.current_rig_id = tracker.get("rig_id", "none")
                self.current_transmitter_id = tracker.get("transmitter_id", "none")
                self.current_rig_vfo = tracker.get("rig_vfo", "none")
                self.current_vfo1 = tracker.get("vfo1", "uplink")
                self.current_vfo2 = tracker.get("vfo2", "downlink")
                self.current_rotator_state = tracker.get("rotator_state", "disconnected")
                self.current_rig_state = tracker.get("rig_state", "disconnected")

                # Check for state changes and handle them
                changes = self.state_manager.check_state_changes()
                await self.state_manager.process_state_changes(changes)

                # Validate hardware states
                await self.state_manager.validate_hardware_states()

                # Update hardware positions (allow tracking to continue if rotator fails)
                try:
                    await self.rotator_handler.update_hardware_position()
                except Exception as e:
                    logger.warning(f"Rotator communication failed, continuing tracking: {e}")

                # Update rig frequency (allow tracking to continue if rig fails)
                try:
                    await self.rig_handler.update_hardware_frequency()
                except Exception as e:
                    logger.warning(f"Rig communication failed, continuing tracking: {e}")

                # Work on sky coordinates
                skypoint = (
                    self.satellite_data["position"]["az"],
                    self.satellite_data["position"]["el"],
                )

                # Check position limits
                self.rotator_handler.check_position_limits(skypoint, satellite_name)

                # Handle transmitter tracking
                await self.rig_handler.handle_transmitter_tracking(satellite_tles, location)

                # Calculate doppler shift for all active transmitters
                await self.rig_handler.calculate_all_transmitters_doppler(satellite_tles, location)
                transmitters = self.rig_data.get("transmitters") or []
                transmitter_count = len(transmitters) if isinstance(transmitters, list) else 0
                logger.debug(
                    "Target #%s %s az=%.4f el=%.4f tx=%s dopplers=%s",
                    self.current_norad_id,
                    satellite_name,
                    skypoint[0],
                    skypoint[1],
                    self.current_transmitter_id,
                    transmitter_count,
                )

                # Control rig frequency
                await self.rig_handler.control_rig_frequency()

                # Control rotator position
                await self.rotator_handler.control_rotator_position(skypoint)

            except Exception as e:
                logger.error(f"Error in satellite tracking task: {e}")
                logger.exception(e)
                self.stats["errors"] += 1

            finally:
                # Check for race condition: re-read tracking state and compare
                final_tracking_state = self.input_tracking_state

                # Send updates via the queue
                # Check if we have satellite data and tracker data
                if self.satellite_data and tracker:
                    # Check if tracking state changed during iteration
                    if (
                        initial_tracking_state
                        and final_tracking_state
                        and initial_tracking_state != final_tracking_state
                    ):
                        pass
                    else:
                        try:
                            full_msg = {
                                DictKeys.EVENT: SocketEvents.SATELLITE_TRACKING,
                                DictKeys.DATA: {
                                    DictKeys.SATELLITE_DATA: self.satellite_data,
                                    DictKeys.EVENTS: self.events.copy(),
                                    DictKeys.ROTATOR_DATA: self.rotator_data.copy(),
                                    DictKeys.RIG_DATA: self.rig_data.copy(),
                                    DictKeys.TRACKING_STATE: tracker.copy(),
                                },
                            }
                            self.queue_out.put(full_msg)
                            self.stats["updates_sent"] += 1

                        except Exception as e:
                            logger.critical(f"Error sending satellite tracking data: {e}")
                            self.stats["errors"] += 1
                            logger.exception(e)

                # Calculate sleep time
                if self.start_loop_date:
                    loop_duration = round(
                        (datetime.now(timezone.utc) - self.start_loop_date).total_seconds(),
                        2,
                    )
                else:
                    loop_duration = 0

                if loop_duration > interval_seconds:
                    logger.warning(
                        f"Single tracking loop iteration took longer "
                        f"({loop_duration}) than the configured "
                        f"interval ({interval_seconds})"
                    )

                remaining_time_to_sleep = max((interval_seconds - loop_duration), 0)

                # Clean up data states
                self.state_manager.cleanup_data_states()

                # Check if stop_event is set before sleeping
                if self.stop_event and self.stop_event.is_set():
                    logger.info("Stop event detected, exiting tracking task")
                    break

                await asyncio.sleep(remaining_time_to_sleep)

    def apply_input_message(self, message: Dict[str, Any]) -> None:
        """Apply IPC message payloads sent from the manager."""
        msg_type = message.get("type")
        payload = message.get("payload", {})

        if msg_type == TRACKER_MSG_SET_TRACKING_STATE:
            self.input_tracking_state = dict(payload)
        elif msg_type == TRACKER_MSG_SET_LOCATION:
            self.input_location = dict(payload)
        elif msg_type == TRACKER_MSG_SET_TRANSMITTERS:
            self.input_transmitters = list(payload.get("items", []))
        elif msg_type == TRACKER_MSG_SET_SATELLITE_EPHEMERIS:
            self.input_satellite = dict(payload)
        elif msg_type == TRACKER_MSG_SET_MAP_SETTINGS:
            self.input_map_settings = dict(payload)
        elif msg_type == TRACKER_MSG_SET_HARDWARE:
            self.input_hardware.update(payload)
            if payload.get("rig"):
                self.rig_details = payload["rig"]
            if payload.get("sdr"):
                self.rig_details = payload["sdr"]
            if payload.get("rotator"):
                self.rotator_details = payload["rotator"]
        elif msg_type == TRACKER_MSG_COMMAND:
            # handled in StateManager.process_commands
            return


async def satellite_tracking_task(
    queue_out: multiprocessing.Queue, queue_in: multiprocessing.Queue, stop_event=None
):
    """
    Wrapper function that creates and runs a SatelliteTracker instance.
    This maintains compatibility with existing multiprocessing code.

    Periodically tracks and transmits satellite position and details along with user location data
    using multiprocessing Queue instead of Socket.IO for inter-process communication.

    This function performs satellite tracking by retrieving tracking states, determining current
    satellite position, and calculating azimuth and elevation values based on user geographic
    location. Data retrieval is achieved through database queries for satellite and user
    information, and updates are transmitted via the queue_out Queue.

    :param queue_out: Queue to send tracking data to the main process
    :type queue_out: multiprocessing.Queue
    :param queue_in: Queue to receive commands from the main process
    :type queue_in: multiprocessing.Queue
    :param stop_event: Event to signal this function to stop execution
    :type stop_event: multiprocessing.Event
    :return: None
    """
    tracker = SatelliteTracker(queue_out, queue_in, stop_event)
    await tracker.run()
