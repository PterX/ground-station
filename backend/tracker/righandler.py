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

"""
Rig handler for satellite tracking.
Handles all rig-related operations including connection, frequency control, and doppler calculation.
"""

import logging
import time

from common.constants import DictKeys, SocketEvents, TrackingEvents
from controllers.rig import RigController
from controllers.sdr import SDRController
from tracking.doppler import calculate_doppler_shift

logger = logging.getLogger("tracker-worker")


class RigHandler:
    """Handles all rig-related operations for satellite tracking."""

    OFFSET_DEADBAND_HZ = 20.0
    MAX_ABS_OFFSET_HZ = 200000.0
    MAX_OFFSET_STEP_HZ = 3000.0
    OFFSET_STABLE_SAMPLES = 2

    def __init__(self, tracker):
        """
        Initialize the rig handler.

        :param tracker: Reference to the parent SatelliteTracker instance
        """
        self.tracker = tracker
        self.last_vfo_update_time = 0.0  # Track when VFO frequencies were last updated
        self.failed_tx_control_modes: set[str] = set()
        self.operator_downlink_offset_hz = 0.0
        self.pending_operator_offset_hz: float | None = None
        self.pending_operator_offset_samples = 0
        self.last_offset_context = {"norad_id": None, "transmitter_id": None}

    def _reset_operator_offset(self, reason: str) -> None:
        if abs(self.operator_downlink_offset_hz) > 0:
            logger.debug(
                "Resetting operator downlink offset (%s): %s Hz",
                reason,
                self.operator_downlink_offset_hz,
            )
        self.operator_downlink_offset_hz = 0.0
        self.pending_operator_offset_hz = None
        self.pending_operator_offset_samples = 0
        self.tracker.rig_data["operator_downlink_offset_hz"] = 0

    def _get_retune_interval_seconds(self) -> float:
        details = self.tracker.rig_details or {}
        configured = details.get("retune_interval_ms", 2000)
        try:
            interval_ms = int(configured)
        except (TypeError, ValueError):
            interval_ms = 2000
        interval_ms = min(max(interval_ms, 100), 60000)
        self.tracker.rig_data["retune_interval_ms"] = interval_ms
        return interval_ms / 1000.0

    def _follow_downlink_tuning_enabled(self) -> bool:
        details = self.tracker.rig_details or {}
        enabled = bool(details.get("follow_downlink_tuning", False))
        self.tracker.rig_data["follow_downlink_tuning"] = enabled
        return enabled

    def _maybe_reset_offset_context(self) -> None:
        norad_id = self.tracker.current_norad_id
        transmitter_id = self.tracker.current_transmitter_id
        if (
            self.last_offset_context["norad_id"] != norad_id
            or self.last_offset_context["transmitter_id"] != transmitter_id
        ):
            self._reset_operator_offset("tracking context changed")
            self.last_offset_context = {"norad_id": norad_id, "transmitter_id": transmitter_id}

    def _apply_operator_offset_to_targets(self, transmitter, vfo1_freq, vfo2_freq):
        offset_hz = self.operator_downlink_offset_hz
        if abs(offset_hz) <= 0:
            return vfo1_freq, vfo2_freq

        invert = bool(transmitter.get("invert", False))
        uplink_offset_hz = -offset_hz if invert else offset_hz

        if self.tracker.current_vfo1 == "downlink" and vfo1_freq and vfo1_freq > 0:
            vfo1_freq = vfo1_freq + offset_hz
        if self.tracker.current_vfo2 == "downlink" and vfo2_freq and vfo2_freq > 0:
            vfo2_freq = vfo2_freq + offset_hz
        if self.tracker.current_vfo1 == "uplink" and vfo1_freq and vfo1_freq > 0:
            vfo1_freq = vfo1_freq + uplink_offset_hz
        if self.tracker.current_vfo2 == "uplink" and vfo2_freq and vfo2_freq > 0:
            vfo2_freq = vfo2_freq + uplink_offset_hz

        return vfo1_freq, vfo2_freq

    def _learn_operator_downlink_offset(
        self, predicted_downlink_freq: float, downlink_vfo: str | None, ptt_active: bool
    ) -> None:
        if not self._follow_downlink_tuning_enabled():
            self._reset_operator_offset("follow_downlink_tuning disabled")
            return
        if ptt_active:
            return
        if not predicted_downlink_freq or predicted_downlink_freq <= 0:
            return

        # If active VFO is known and not downlink, avoid learning from unrelated dial changes.
        active_vfo = str(self.tracker.current_rig_vfo or "").strip()
        if active_vfo in {"1", "2"} and downlink_vfo in {"1", "2"} and active_vfo != downlink_vfo:
            return

        actual_downlink = self.tracker.rig_data.get("frequency", 0)
        if not actual_downlink or actual_downlink <= 0:
            return

        raw_offset = float(actual_downlink) - float(predicted_downlink_freq)
        if abs(raw_offset) <= self.OFFSET_DEADBAND_HZ:
            raw_offset = 0.0

        if abs(raw_offset) > self.MAX_ABS_OFFSET_HZ:
            logger.debug(
                "Ignoring operator offset %.1f Hz (outside max window %.1f Hz)",
                raw_offset,
                self.MAX_ABS_OFFSET_HZ,
            )
            return

        if abs(raw_offset - self.operator_downlink_offset_hz) > self.MAX_OFFSET_STEP_HZ:
            logger.debug(
                "Ignoring operator offset step %.1f Hz (max step %.1f Hz)",
                raw_offset - self.operator_downlink_offset_hz,
                self.MAX_OFFSET_STEP_HZ,
            )
            return

        if (
            self.pending_operator_offset_hz is not None
            and abs(raw_offset - self.pending_operator_offset_hz) <= self.OFFSET_DEADBAND_HZ
        ):
            self.pending_operator_offset_samples += 1
        else:
            self.pending_operator_offset_hz = raw_offset
            self.pending_operator_offset_samples = 1

        if self.pending_operator_offset_samples < self.OFFSET_STABLE_SAMPLES:
            return

        self.operator_downlink_offset_hz = float(self.pending_operator_offset_hz or 0.0)
        self.pending_operator_offset_hz = None
        self.pending_operator_offset_samples = 0
        self.tracker.rig_data["operator_downlink_offset_hz"] = int(
            round(self.operator_downlink_offset_hz)
        )
        logger.debug(
            "Applied operator downlink offset %.1f Hz (actual=%.1f, predicted=%.1f)",
            self.operator_downlink_offset_hz,
            float(actual_downlink),
            float(predicted_downlink_freq),
        )

    def _apply_radio_mode_to_targets(
        self,
        mode: str,
        vfo1_freq,
        vfo2_freq,
        downlink_vfo,
        ptt_active: bool,
    ) -> tuple[float, float, str | None]:
        """Apply radio_mode semantics to computed targets.

        Returns a tuple of (vfo1_freq, vfo2_freq, downlink_vfo).
        """
        mode = mode or "duplex"

        if mode == "monitor":
            if self.tracker.current_vfo1 == "uplink":
                vfo1_freq = 0
            if self.tracker.current_vfo2 == "uplink":
                vfo2_freq = 0
            return vfo1_freq, vfo2_freq, downlink_vfo

        if mode == "uplink_only":
            if self.tracker.current_vfo1 == "downlink":
                vfo1_freq = 0
            if self.tracker.current_vfo2 == "downlink":
                vfo2_freq = 0
            return vfo1_freq, vfo2_freq, None

        if mode == "simplex":
            selected_vfo = str(self.tracker.current_rig_vfo or "").strip()
            keep_vfo = None
            if selected_vfo in {"1", "2"}:
                keep_vfo = selected_vfo
            elif downlink_vfo in {"1", "2"}:
                keep_vfo = downlink_vfo
            else:
                keep_vfo = "1"

            if keep_vfo == "1":
                vfo2_freq = 0
                downlink_vfo = "1" if self.tracker.current_vfo1 == "downlink" else None
            else:
                vfo1_freq = 0
                downlink_vfo = "2" if self.tracker.current_vfo2 == "downlink" else None
            return vfo1_freq, vfo2_freq, downlink_vfo

        if mode == "ptt_guarded" and ptt_active:
            # During TX, freeze uplink retunes but still allow downlink updates.
            if self.tracker.current_vfo1 == "uplink":
                vfo1_freq = 0
            if self.tracker.current_vfo2 == "uplink":
                vfo2_freq = 0
            return vfo1_freq, vfo2_freq, downlink_vfo

        # duplex/default: leave both paths enabled
        return vfo1_freq, vfo2_freq, downlink_vfo

    async def connect_to_rig(self):
        """Connect to rig hardware (radio or SDR)."""
        if self.tracker.current_rig_id is not None and self.tracker.rig_controller is None:
            try:
                rig_details = self.tracker.rig_details
                rig_type = (self.tracker.input_hardware or {}).get("rig_type", "radio")

                if not rig_details:
                    raise Exception(
                        f"No rig details provided for ID: {self.tracker.current_rig_id}"
                    )

                # Create appropriate controller
                if rig_type == "sdr":
                    self.tracker.rig_controller = SDRController(sdr_details=rig_details)
                else:
                    self.tracker.rig_controller = RigController(
                        host=rig_details["host"], port=rig_details["port"]
                    )

                self.tracker.rig_details.update(
                    {
                        "host": self.tracker.rig_details["host"],
                        "port": self.tracker.rig_details.get("port"),
                    },
                )

                await self.tracker.rig_controller.connect()
                self.failed_tx_control_modes.clear()
                self._reset_operator_offset("rig connected")

                # Update state
                self.tracker.rig_data.update(
                    {
                        "connected": True,
                        "tracking": False,
                        "tuning": False,
                        "device_type": rig_details.get("type", "hardware"),
                        "host": self.tracker.rig_details.get("host", ""),
                        "port": self.tracker.rig_details.get("port", ""),
                        "radio_mode": rig_details.get("radio_mode", "duplex"),
                        "tx_control_mode": rig_details.get("tx_control_mode", "auto"),
                        "active_tx_control_mode": "vfo_switch",
                        "retune_interval_ms": int(rig_details.get("retune_interval_ms", 2000)),
                        "follow_downlink_tuning": bool(
                            rig_details.get("follow_downlink_tuning", False)
                        ),
                        "operator_downlink_offset_hz": 0,
                    }
                )

                self.tracker.queue_out.put(
                    {
                        DictKeys.EVENT: SocketEvents.SATELLITE_TRACKING,
                        DictKeys.DATA: {
                            DictKeys.EVENTS: [{DictKeys.NAME: TrackingEvents.RIG_CONNECTED}],
                            DictKeys.RIG_DATA: self.tracker.rig_data.copy(),
                        },
                    }
                )

            except Exception as e:
                logger.error(f"Failed to connect to rig: {e}")
                logger.exception(e)
                await self.handle_rig_error(e)

    async def handle_rig_error(self, error):
        """Handle rig connection errors."""
        self.tracker.rig_data.update(
            {
                "connected": False,
                "tracking": False,
                "tuning": False,
                "error": True,
                "host": self.tracker.rig_data.get("host", ""),
                "port": self.tracker.rig_data.get("port", ""),
            }
        )

        updated_tracking_state = dict(self.tracker.input_tracking_state or {})
        updated_tracking_state["rig_state"] = "disconnected"
        self.tracker.input_tracking_state = updated_tracking_state

        self.tracker.queue_out.put(
            {
                DictKeys.EVENT: SocketEvents.SATELLITE_TRACKING,
                DictKeys.DATA: {
                    DictKeys.EVENTS: [
                        {DictKeys.NAME: TrackingEvents.RIG_ERROR, "error": str(error)}
                    ],
                    DictKeys.RIG_DATA: self.tracker.rig_data.copy(),
                    DictKeys.TRACKING_STATE: updated_tracking_state,
                },
            }
        )

        self.tracker.rig_controller = None

    async def handle_rig_state_change(self, old, new):
        """Handle rig state changes."""
        logger.info(f"Rig state change detected from '{old}' to '{new}'")

        if new == "connected":
            await self.connect_to_rig()
            self.tracker.rig_data["connected"] = True

        elif new == "disconnected":
            await self.disconnect_rig()
            self.tracker.rig_data["connected"] = False
            self.tracker.rig_data["tracking"] = False
            self.tracker.rig_data["stopped"] = True
            self._reset_operator_offset("rig disconnected")

        elif new == "tracking":
            await self.connect_to_rig()
            self.tracker.rig_data["tracking"] = True
            self.tracker.rig_data["stopped"] = False

        elif new == "stopped":
            self.tracker.rig_data["tracking"] = False
            self.tracker.rig_data["tuning"] = False
            self.tracker.rig_data["stopped"] = True
            self._reset_operator_offset("tracking stopped")

    async def disconnect_rig(self):
        """Disconnect from rig."""
        if self.tracker.rig_controller is not None:
            logger.info("Disconnecting from rig...")
            try:
                await self.tracker.rig_controller.disconnect()
                self.tracker.rig_data.update(
                    {"connected": False, "tracking": False, "tuning": False}
                )
                self.tracker.queue_out.put(
                    {
                        DictKeys.EVENT: SocketEvents.SATELLITE_TRACKING,
                        DictKeys.DATA: {
                            DictKeys.EVENTS: [{DictKeys.NAME: TrackingEvents.RIG_DISCONNECTED}],
                            DictKeys.RIG_DATA: self.tracker.rig_data.copy(),
                        },
                    }
                )
            except Exception as e:
                logger.error(f"Error disconnecting from rig: {e}")
                logger.exception(e)
            finally:
                self.tracker.rig_controller = None

    async def handle_transmitter_tracking(self, satellite_tles, location):
        """Handle transmitter selection and doppler calculation for both RX and TX."""
        if self.tracker.current_transmitter_id != "none":
            current_transmitter = next(
                (
                    t
                    for t in self.tracker.input_transmitters
                    if t.get("id") == self.tracker.current_transmitter_id
                ),
                None,
            )

            if current_transmitter:
                downlink_freq = current_transmitter.get("downlink_low", 0)
                uplink_freq = current_transmitter.get("uplink_low", 0)

                self.tracker.rig_data["original_freq"] = downlink_freq
                self.tracker.rig_data["uplink_freq"] = uplink_freq

                # Calculate RX (downlink) doppler shift
                if downlink_freq and downlink_freq > 0:
                    (
                        self.tracker.rig_data["downlink_observed_freq"],
                        self.tracker.rig_data["doppler_shift"],
                    ) = calculate_doppler_shift(
                        satellite_tles[0],
                        satellite_tles[1],
                        location["lat"],
                        location["lon"],
                        0,
                        downlink_freq,
                    )
                else:
                    self.tracker.rig_data["downlink_observed_freq"] = 0
                    self.tracker.rig_data["doppler_shift"] = 0

                # Calculate TX (uplink) doppler shift (inverted)
                if uplink_freq and uplink_freq > 0:
                    uplink_observed, uplink_doppler = calculate_doppler_shift(
                        satellite_tles[0],
                        satellite_tles[1],
                        location["lat"],
                        location["lon"],
                        0,
                        uplink_freq,
                    )
                    # For TX, apply opposite correction
                    self.tracker.rig_data["uplink_observed_freq"] = (
                        2 * uplink_freq - uplink_observed
                    )
                    self.tracker.rig_data["uplink_doppler_shift"] = -uplink_doppler
                else:
                    self.tracker.rig_data["uplink_observed_freq"] = 0
                    self.tracker.rig_data["uplink_doppler_shift"] = 0

                if self.tracker.current_rig_state == "tracking":
                    self.tracker.rig_data["tracking"] = True
                    self.tracker.rig_data["stopped"] = False

                else:
                    self.tracker.rig_data["downlink_observed_freq"] = 0
                    self.tracker.rig_data["doppler_shift"] = 0
                    self.tracker.rig_data["uplink_observed_freq"] = 0
                    self.tracker.rig_data["uplink_doppler_shift"] = 0
                    self.tracker.rig_data["tracking"] = False
                    self.tracker.rig_data["stopped"] = True

            self.tracker.rig_data["transmitter_id"] = self.tracker.current_transmitter_id

        else:
            self.tracker.rig_data["transmitter_id"] = self.tracker.current_transmitter_id
            self.tracker.rig_data["downlink_observed_freq"] = 0
            self.tracker.rig_data["doppler_shift"] = 0
            self.tracker.rig_data["uplink_observed_freq"] = 0
            self.tracker.rig_data["uplink_doppler_shift"] = 0
            self.tracker.rig_data["uplink_freq"] = 0
            self.tracker.rig_data["tracking"] = False
            self.tracker.rig_data["stopped"] = True

    async def calculate_all_transmitters_doppler(self, satellite_tles, location):
        """Calculate doppler shift for all active transmitters of the current satellite.

        For RX (downlink): Applies positive doppler shift when satellite approaches.
        For TX (uplink): Applies negative doppler shift (opposite direction) so that
        the satellite receives the correct frequency after doppler effect.
        """
        if self.tracker.current_norad_id is None:
            self.tracker.rig_data["transmitters"] = []
            return

        try:
            transmitters_with_doppler = []
            for transmitter in self.tracker.input_transmitters:
                downlink_freq = transmitter.get("downlink_low", 0)
                uplink_freq = transmitter.get("uplink_low", 0)

                transmitter_data = {
                    "id": transmitter.get("id"),
                    "description": transmitter.get("description"),
                    "type": transmitter.get("type"),
                    "mode": transmitter.get("mode"),
                    "invert": transmitter.get("invert", False),
                    "source": transmitter.get("source"),
                    "alive": transmitter.get("alive"),
                    "downlink_low": downlink_freq,
                    "downlink_high": transmitter.get("downlink_high"),
                    "uplink_low": uplink_freq,
                    "uplink_high": transmitter.get("uplink_high"),
                }

                # Calculate RX (downlink) doppler shift
                if downlink_freq and downlink_freq > 0:
                    downlink_observed_freq, doppler_shift = calculate_doppler_shift(
                        satellite_tles[0],
                        satellite_tles[1],
                        location["lat"],
                        location["lon"],
                        0,
                        downlink_freq,
                    )
                    transmitter_data["downlink_observed_freq"] = downlink_observed_freq
                    transmitter_data["doppler_shift"] = doppler_shift
                else:
                    transmitter_data["downlink_observed_freq"] = 0
                    transmitter_data["doppler_shift"] = 0

                # Calculate TX (uplink) doppler shift (inverted)
                if uplink_freq and uplink_freq > 0:
                    # Calculate the doppler shift for uplink
                    uplink_observed, uplink_doppler = calculate_doppler_shift(
                        satellite_tles[0],
                        satellite_tles[1],
                        location["lat"],
                        location["lon"],
                        0,
                        uplink_freq,
                    )
                    # For TX, we need to apply the opposite correction:
                    # If satellite is approaching (positive doppler), we transmit lower
                    # If satellite is receding (negative doppler), we transmit higher
                    transmitter_data["uplink_observed_freq"] = 2 * uplink_freq - uplink_observed
                    transmitter_data["uplink_doppler_shift"] = -uplink_doppler
                else:
                    transmitter_data["uplink_observed_freq"] = 0
                    transmitter_data["uplink_doppler_shift"] = 0

                # Only include transmitters that have at least downlink or uplink
                if downlink_freq > 0 or uplink_freq > 0:
                    transmitters_with_doppler.append(transmitter_data)

            self.tracker.rig_data["transmitters"] = transmitters_with_doppler
            # Debug log handled by tracker loop for compact output.

        except Exception as e:
            logger.error(f"Error calculating doppler for all transmitters: {e}")
            logger.exception(e)
            self.tracker.rig_data["transmitters"] = []

    async def control_rig_frequency(self):
        """Control rig frequency based on doppler calculations for both VFOs."""
        if self.tracker.rig_controller and self.tracker.current_rig_state == "tracking":
            # Check if this is an SDR or hardware rig
            if isinstance(self.tracker.rig_controller, SDRController):
                # SDR: Don't set center frequency - user controls that manually from UI
                # VFO frequency updates are handled in vfos/updates.py:handle_vfo_updates_for_tracking()
                logger.debug(
                    f"SDR tracking - doppler freq: {self.tracker.rig_data['downlink_observed_freq']:.0f} Hz (VFO updates handled separately)"
                )

            else:
                current_time = time.time()
                retune_interval_seconds = self._get_retune_interval_seconds()
                if current_time - self.last_vfo_update_time < retune_interval_seconds:
                    return
                self.last_vfo_update_time = current_time

                self._maybe_reset_offset_context()

                transmitter = None
                if self.tracker.current_transmitter_id != "none":
                    for t in self.tracker.rig_data.get("transmitters", []):
                        if t["id"] == self.tracker.current_transmitter_id:
                            transmitter = t
                            break
                if not transmitter:
                    return

                vfo1_freq = None
                vfo2_freq = None
                downlink_vfo = None
                if self.tracker.current_vfo1 == "uplink":
                    vfo1_freq = transmitter.get("uplink_observed_freq", 0)
                elif self.tracker.current_vfo1 == "downlink":
                    vfo1_freq = transmitter.get("downlink_observed_freq", 0)
                    downlink_vfo = "1"

                if self.tracker.current_vfo2 == "uplink":
                    vfo2_freq = transmitter.get("uplink_observed_freq", 0)
                elif self.tracker.current_vfo2 == "downlink":
                    vfo2_freq = transmitter.get("downlink_observed_freq", 0)
                    downlink_vfo = "2"

                predicted_downlink_freq = transmitter.get("downlink_observed_freq", 0)

                configured_tx_control_mode = (self.tracker.rig_details or {}).get(
                    "tx_control_mode", "auto"
                )
                effective_tx_control_mode = self._resolve_tx_control_mode(
                    configured_tx_control_mode
                )
                configured_radio_mode = (self.tracker.rig_details or {}).get("radio_mode", "duplex")

                ptt_active = await self._is_ptt_active()
                if ptt_active and configured_radio_mode != "ptt_guarded":
                    logger.debug("PTT active, skipping rig retune cycle for safety")
                    return

                self._learn_operator_downlink_offset(
                    predicted_downlink_freq=predicted_downlink_freq,
                    downlink_vfo=downlink_vfo,
                    ptt_active=ptt_active,
                )

                vfo1_freq, vfo2_freq, downlink_vfo = self._apply_radio_mode_to_targets(
                    mode=configured_radio_mode,
                    vfo1_freq=vfo1_freq,
                    vfo2_freq=vfo2_freq,
                    downlink_vfo=downlink_vfo,
                    ptt_active=ptt_active,
                )
                vfo1_freq, vfo2_freq = self._apply_operator_offset_to_targets(
                    transmitter=transmitter,
                    vfo1_freq=vfo1_freq,
                    vfo2_freq=vfo2_freq,
                )

                allow_downlink = any(
                    [
                        self.tracker.current_vfo1 == "downlink" and vfo1_freq and vfo1_freq > 0,
                        self.tracker.current_vfo2 == "downlink" and vfo2_freq and vfo2_freq > 0,
                    ]
                )
                allow_uplink = any(
                    [
                        self.tracker.current_vfo1 == "uplink" and vfo1_freq and vfo1_freq > 0,
                        self.tracker.current_vfo2 == "uplink" and vfo2_freq and vfo2_freq > 0,
                    ]
                )

                self.tracker.rig_data["radio_mode"] = configured_radio_mode
                self.tracker.rig_data["tx_control_mode"] = configured_tx_control_mode
                self.tracker.rig_data["active_tx_control_mode"] = effective_tx_control_mode
                self.tracker.rig_data["operator_downlink_offset_hz"] = int(
                    round(self.operator_downlink_offset_hz)
                )

                if effective_tx_control_mode == "split_tx_cmd":
                    try:
                        await self._control_split_tx_cmd(
                            transmitter=transmitter,
                            vfo1_freq=vfo1_freq,
                            vfo2_freq=vfo2_freq,
                            allow_downlink=allow_downlink,
                            allow_uplink=allow_uplink,
                        )
                        return
                    except Exception as e:
                        logger.warning(
                            "split_tx_cmd strategy failed (%s); attempting fallback strategy", e
                        )
                        self.failed_tx_control_modes.add("split_tx_cmd")
                        if (
                            configured_tx_control_mode == "auto"
                            and isinstance(self.tracker.rig_controller, RigController)
                            and self.tracker.rig_controller.supports_explicit_vfo_cmd
                            and "vfo_explicit" not in self.failed_tx_control_modes
                        ):
                            try:
                                await self._control_vfo_explicit(
                                    transmitter=transmitter,
                                    vfo1_freq=vfo1_freq,
                                    vfo2_freq=vfo2_freq,
                                )
                                self.tracker.rig_data["active_tx_control_mode"] = "vfo_explicit"
                                return
                            except Exception as explicit_error:
                                logger.warning(
                                    "vfo_explicit fallback strategy failed (%s); using vfo_switch",
                                    explicit_error,
                                )
                                self.failed_tx_control_modes.add("vfo_explicit")
                        self.tracker.rig_data["active_tx_control_mode"] = "vfo_switch"

                if effective_tx_control_mode == "vfo_explicit":
                    try:
                        await self._control_vfo_explicit(
                            transmitter=transmitter,
                            vfo1_freq=vfo1_freq,
                            vfo2_freq=vfo2_freq,
                        )
                        return
                    except Exception as e:
                        logger.warning(
                            "vfo_explicit strategy failed (%s); falling back to vfo_switch", e
                        )
                        self.failed_tx_control_modes.add("vfo_explicit")
                        self.tracker.rig_data["active_tx_control_mode"] = "vfo_switch"

                await self._control_vfo_switch(
                    transmitter=transmitter,
                    vfo1_freq=vfo1_freq,
                    vfo2_freq=vfo2_freq,
                    downlink_vfo=downlink_vfo,
                )

    def _resolve_tx_control_mode(self, configured_tx_control_mode: str) -> str:
        if configured_tx_control_mode == "vfo_switch":
            return "vfo_switch"
        if configured_tx_control_mode == "split_tx_cmd":
            return "split_tx_cmd"
        if configured_tx_control_mode == "vfo_explicit":
            return "vfo_explicit"
        if isinstance(self.tracker.rig_controller, RigController):
            if (
                self.tracker.rig_controller.supports_split_tx_cmd
                and "split_tx_cmd" not in self.failed_tx_control_modes
            ):
                return "split_tx_cmd"
            if (
                self.tracker.rig_controller.supports_explicit_vfo_cmd
                and "vfo_explicit" not in self.failed_tx_control_modes
            ):
                return "vfo_explicit"
        return "vfo_switch"

    async def _is_ptt_active(self) -> bool:
        if not isinstance(self.tracker.rig_controller, RigController):
            return False
        if not self.tracker.rig_controller.supports_ptt_query:
            return False
        try:
            ptt_state = await self.tracker.rig_controller.get_ptt()
            return bool(ptt_state)
        except Exception:
            return False

    async def _control_split_tx_cmd(
        self, transmitter, vfo1_freq, vfo2_freq, allow_downlink: bool, allow_uplink: bool
    ):
        if not isinstance(self.tracker.rig_controller, RigController):
            return

        downlink_freq = 0
        uplink_freq = 0

        # Prefer already-resolved VFO frequencies (includes offset/radio_mode logic).
        if self.tracker.current_vfo1 == "downlink" and vfo1_freq and vfo1_freq > 0:
            downlink_freq = vfo1_freq
        if self.tracker.current_vfo2 == "downlink" and vfo2_freq and vfo2_freq > 0:
            downlink_freq = vfo2_freq
        if self.tracker.current_vfo1 == "uplink" and vfo1_freq and vfo1_freq > 0:
            uplink_freq = vfo1_freq
        if self.tracker.current_vfo2 == "uplink" and vfo2_freq and vfo2_freq > 0:
            uplink_freq = vfo2_freq

        # Fallback to transmitter frequencies if VFO assignment did not yield a target.
        if (not downlink_freq or downlink_freq <= 0) and allow_downlink:
            downlink_freq = transmitter.get("downlink_observed_freq", 0)
        if (not uplink_freq or uplink_freq <= 0) and allow_uplink:
            uplink_freq = transmitter.get("uplink_observed_freq", 0)

        if allow_downlink and downlink_freq and downlink_freq > 0:
            success = await self.tracker.rig_controller.set_frequency_direct(downlink_freq)
            if not success:
                raise RuntimeError("Failed setting downlink via direct RX command")

        if allow_uplink and uplink_freq and uplink_freq > 0:
            success = await self.tracker.rig_controller.set_tx_frequency(uplink_freq)
            if not success:
                raise RuntimeError("Failed setting uplink via split TX command")

        self.tracker.rig_data["vfo1"] = {
            "frequency": vfo1_freq or 0,
            "mode": transmitter.get("mode", "UNKNOWN"),
            "bandwidth": 0,
        }
        self.tracker.rig_data["vfo2"] = {
            "frequency": vfo2_freq or 0,
            "mode": transmitter.get("mode", "UNKNOWN"),
            "bandwidth": 0,
        }

    async def _control_vfo_switch(self, transmitter, vfo1_freq, vfo2_freq, downlink_vfo):
        # Set VFO 1 frequency if configured
        if vfo1_freq and vfo1_freq > 0:
            try:
                frequency_gen = self.tracker.rig_controller.set_frequency(vfo1_freq, vfo="1")
                current_frequency, is_tuning = await anext(frequency_gen)

                self.tracker.rig_data["vfo1"] = {
                    "frequency": vfo1_freq,
                    "mode": transmitter.get("mode", "UNKNOWN"),
                    "bandwidth": 0,
                }

                logger.debug(
                    "Hardware rig VFO 1 (%s): %s Hz, tuning=%s",
                    self.tracker.current_vfo1,
                    current_frequency,
                    is_tuning,
                )
            except StopAsyncIteration:
                logger.info(
                    "Hardware rig VFO 1 tuned to %s Hz (%s)",
                    vfo1_freq,
                    self.tracker.current_vfo1,
                )
            except Exception as e:
                logger.error(f"Error setting VFO 1 frequency: {e}")

        # Set VFO 2 frequency if configured
        if vfo2_freq and vfo2_freq > 0:
            try:
                frequency_gen = self.tracker.rig_controller.set_frequency(vfo2_freq, vfo="2")
                current_frequency, is_tuning = await anext(frequency_gen)

                self.tracker.rig_data["vfo2"] = {
                    "frequency": vfo2_freq,
                    "mode": transmitter.get("mode", "UNKNOWN"),
                    "bandwidth": 0,
                }

                logger.debug(
                    "Hardware rig VFO 2 (%s): %s Hz, tuning=%s",
                    self.tracker.current_vfo2,
                    current_frequency,
                    is_tuning,
                )
            except StopAsyncIteration:
                logger.info(
                    "Hardware rig VFO 2 tuned to %s Hz (%s)",
                    vfo2_freq,
                    self.tracker.current_vfo2,
                )
            except Exception as e:
                logger.error(f"Error setting VFO 2 frequency: {e}")

        # Keep downlink VFO selected for user operation.
        if downlink_vfo:
            try:
                vfo_name = "VFOA" if downlink_vfo == "1" else "VFOB"
                await self.tracker.rig_controller.set_vfo(vfo_name)
                logger.debug(f"Selected {vfo_name} (downlink) for user operation")
            except Exception as e:
                logger.error(f"Error selecting downlink VFO: {e}")

    async def _control_vfo_explicit(self, transmitter, vfo1_freq, vfo2_freq):
        if not isinstance(self.tracker.rig_controller, RigController):
            return

        if vfo1_freq and vfo1_freq > 0:
            success = await self.tracker.rig_controller.set_frequency_explicit_vfo(
                "VFOA", vfo1_freq
            )
            if not success:
                raise RuntimeError("Failed to set explicit VFOA frequency")
            self.tracker.rig_data["vfo1"] = {
                "frequency": vfo1_freq,
                "mode": transmitter.get("mode", "UNKNOWN"),
                "bandwidth": 0,
            }
            logger.debug("Explicit VFOA tuned to %s Hz", vfo1_freq)

        if vfo2_freq and vfo2_freq > 0:
            success = await self.tracker.rig_controller.set_frequency_explicit_vfo(
                "VFOB", vfo2_freq
            )
            if not success:
                raise RuntimeError("Failed to set explicit VFOB frequency")
            self.tracker.rig_data["vfo2"] = {
                "frequency": vfo2_freq,
                "mode": transmitter.get("mode", "UNKNOWN"),
                "bandwidth": 0,
            }
            logger.debug("Explicit VFOB tuned to %s Hz", vfo2_freq)

    async def update_hardware_frequency(self):
        """Update current rig frequency (no VFO reading to avoid switching)."""
        if self.tracker.rig_controller:
            # Get main frequency (current VFO)
            self.tracker.rig_data["frequency"] = await self.tracker.rig_controller.get_frequency()

            # Don't read VFO data from rig to avoid VFO switching
            # VFO data is populated by control_rig_frequency() when setting frequencies
