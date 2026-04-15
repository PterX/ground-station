# Ground Station - IQ Recorder
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


import json
import logging
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict

import numpy as np
from scipy.signal import resample_poly

logger = logging.getLogger("iq-recorder")


class IQRecorder(threading.Thread):
    """
    IQ recorder that subscribes to IQ samples and writes them to SigMF format.

    Behaves like a demodulator but writes raw IQ instead of producing audio.
    This allows recording to be managed through the same infrastructure as demodulators.
    """

    def __init__(
        self,
        iq_queue,
        audio_queue,
        session_id,
        recording_path,
        target_satellite_norad_id="",
        target_satellite_name="",
        target_center_freq=None,
        enable_frequency_shift=False,
        decimation_factor=1,
    ):
        super().__init__(daemon=True, name=f"IQRecorder-{session_id}")
        self.iq_queue = iq_queue
        self.recording_path = Path(recording_path)
        self.session_id = session_id
        self.running = True
        self.target_satellite_norad_id = target_satellite_norad_id
        self.target_satellite_name = target_satellite_name
        self.target_center_freq = target_center_freq
        self.enable_frequency_shift = enable_frequency_shift
        self.decimation_factor = int(decimation_factor) if decimation_factor else 1
        if self.decimation_factor < 1:
            logger.warning(f"Invalid decimation factor {decimation_factor}, falling back to 1")
            self.decimation_factor = 1

        # Frequency shift tracking
        self.shift_hz = 0
        self.phase = 0.0  # Track phase for continuity across chunks

        # Metadata tracking
        self.total_samples = 0
        self.captures = []
        self.annotations = []
        self.current_center_freq = None
        self.current_input_sample_rate = None
        self.current_sample_rate = None
        self.start_datetime = None

        # Store start time to preserve it in final metadata
        # Use timezone-aware datetime and format as ISO string with Z suffix
        self.start_time_iso = (
            datetime.now(timezone.utc).replace(microsecond=0, tzinfo=None).isoformat() + "Z"
        )

        # Performance monitoring stats
        self.stats: Dict[str, Any] = {
            "iq_chunks_in": 0,
            "iq_samples_in": 0,
            "samples_written": 0,
            "bytes_written": 0,
            "queue_timeouts": 0,
            "last_activity": None,
            "errors": 0,
        }
        self.stats_lock = threading.Lock()

        # Open data file for writing
        self.data_file = open(f"{recording_path}.sigmf-data", "wb")

        # Create preliminary sigmf-meta file to mark recording as in progress
        self._write_preliminary_metadata()

        logger.info(f"IQ recorder started: {recording_path}")

    def run(self):
        """Main recording loop."""
        while self.running:
            try:
                if self.iq_queue.empty():
                    time.sleep(0.01)
                    continue

                iq_message = self.iq_queue.get(timeout=0.1)

                # Update stats
                with self.stats_lock:
                    self.stats["iq_chunks_in"] += 1
                    self.stats["last_activity"] = time.time()

                samples = iq_message.get("samples")
                center_freq = iq_message.get(
                    "logical_center_freq_hz", iq_message.get("center_freq")
                )
                sample_rate = iq_message.get("sample_rate")
                timestamp = iq_message.get("timestamp")

                if samples is None or len(samples) == 0:
                    continue

                # Update sample count
                with self.stats_lock:
                    self.stats["iq_samples_in"] += len(samples)

                # Check if parameters changed (new capture segment needed)
                if (
                    self.current_center_freq != center_freq
                    or self.current_input_sample_rate != sample_rate
                ):
                    # Calculate frequency shift if needed
                    if self.enable_frequency_shift and self.target_center_freq is not None:
                        # Shift from current center_freq to target_center_freq
                        # Signal at target_center_freq is at (target - center) offset in current recording
                        # We want to shift it to center (0 Hz offset)
                        self.shift_hz = center_freq - self.target_center_freq
                        output_center_freq = self.target_center_freq
                        logger.info(
                            f"Frequency shift enabled: {center_freq/1e6:.3f} MHz -> {self.target_center_freq/1e6:.3f} MHz "
                            f"(shift by {self.shift_hz/1e3:.1f} kHz)"
                        )
                    else:
                        self.shift_hz = 0
                        output_center_freq = center_freq

                    output_sample_rate = sample_rate / self.decimation_factor

                    # Add new capture segment with output center frequency
                    self.captures.append(
                        {
                            "core:sample_start": self.total_samples,
                            "core:frequency": int(output_center_freq),
                            "core:datetime": datetime.fromtimestamp(timestamp, tz=timezone.utc)
                            .replace(microsecond=0, tzinfo=None)
                            .isoformat()
                            + "Z",
                        }
                    )

                    self.current_center_freq = center_freq
                    self.current_input_sample_rate = sample_rate
                    self.current_sample_rate = output_sample_rate

                    if self.start_datetime is None:
                        self.start_datetime = timestamp

                    logger.info(
                        f"New capture segment at sample {self.total_samples}: "
                        f"freq={output_center_freq/1e6:.3f} MHz, "
                        f"rate={output_sample_rate/1e6:.2f} MS/s"
                    )

                # Apply frequency shift if enabled
                if self.enable_frequency_shift and self.shift_hz != 0:
                    # Generate time array for this chunk
                    t = np.arange(len(samples), dtype=np.float64) / sample_rate
                    # Compute phase incrementally: phase = 2*pi*f*t + phase_offset
                    # To avoid overflow in the argument to exp, we use cos/sin directly
                    # since exp(1j*theta) = cos(theta) + 1j*sin(theta)
                    arg = 2 * np.pi * self.shift_hz * t + self.phase
                    shift_signal = np.cos(arg) + 1j * np.sin(arg)
                    # Apply shift (ensure result stays complex64)
                    samples = (samples * shift_signal).astype(np.complex64)
                    # Update phase for next chunk (wrap to keep bounded)
                    self.phase = (
                        self.phase + 2 * np.pi * self.shift_hz * len(samples) / sample_rate
                    ) % (2 * np.pi)

                # Apply decimation if requested
                if self.decimation_factor > 1:
                    try:
                        samples = resample_poly(samples, up=1, down=self.decimation_factor).astype(
                            np.complex64
                        )
                    except Exception as e:
                        logger.error(f"Failed to decimate IQ samples: {e}")
                        with self.stats_lock:
                            self.stats["errors"] += 1
                        continue

                # Write samples to file
                samples.tofile(self.data_file)
                self.total_samples += len(samples)

                # Update stats (cf32_le = 8 bytes per sample)
                with self.stats_lock:
                    self.stats["samples_written"] += len(samples)
                    self.stats["bytes_written"] += len(samples) * 8

            except Exception as e:
                if self.running:
                    logger.error(f"Error in IQ recorder: {str(e)}")
                    logger.exception(e)
                    with self.stats_lock:
                        self.stats["errors"] += 1
                time.sleep(0.1)

        logger.info(f"IQ recorder stopped: {self.total_samples} samples written")

    def _write_preliminary_metadata(self):
        """Write preliminary metadata file to mark recording as in progress."""
        global_metadata: dict = {
            "core:datatype": "cf32_le",
            "core:version": "1.0.0",
            "core:description": "Ground Station IQ Recording",
            "core:recorder": "ground-station",
            "gs:recording_in_progress": True,
            "gs:start_time": self.start_time_iso,
            "gs:session_id": self.session_id,
        }

        # Add target satellite NORAD ID if provided
        if self.target_satellite_norad_id:
            global_metadata["gs:target_satellite_norad_id"] = self.target_satellite_norad_id

        # Add target satellite name if provided
        if self.target_satellite_name:
            global_metadata["gs:target_satellite_name"] = self.target_satellite_name

        preliminary_metadata = {
            "global": global_metadata,
            "captures": [],
            "annotations": [],
        }

        with open(f"{self.recording_path}.sigmf-meta", "w") as f:
            json.dump(preliminary_metadata, f, indent=2)

        logger.info(f"Preliminary metadata written: {self.recording_path}.sigmf-meta")

    def add_annotation(self, start_sample, sample_count, freq_lower, freq_upper, comment):
        """Add signal annotation to metadata."""
        self.annotations.append(
            {
                "core:sample_start": start_sample,
                "core:sample_count": sample_count,
                "core:freq_lower_edge": int(freq_lower),
                "core:freq_upper_edge": int(freq_upper),
                "core:comment": comment,
            }
        )

    def stop(self):
        """Stop recording and write metadata."""
        self.running = False
        self.join(timeout=2.0)

        # Close data file
        self.data_file.close()

        # Write final SigMF metadata (replaces preliminary metadata, preserves start_time)
        global_metadata: dict = {
            "core:datatype": "cf32_le",
            "core:sample_rate": self.current_sample_rate,
            "core:version": "1.0.0",
            "core:description": "Ground Station IQ Recording",
            "core:recorder": "ground-station",
            "gs:start_time": self.start_time_iso,
            "gs:finalized_time": datetime.now(timezone.utc)
            .replace(microsecond=0, tzinfo=None)
            .isoformat()
            + "Z",
            "gs:session_id": self.session_id,
        }

        # Add target satellite NORAD ID if provided
        if self.target_satellite_norad_id:
            global_metadata["gs:target_satellite_norad_id"] = self.target_satellite_norad_id

        # Add target satellite name if provided
        if self.target_satellite_name:
            global_metadata["gs:target_satellite_name"] = self.target_satellite_name

        # Add frequency shift metadata if applied
        if self.enable_frequency_shift and self.shift_hz != 0:
            global_metadata["gs:frequency_shift_applied"] = True
            global_metadata["gs:frequency_shift_hz"] = self.shift_hz
            global_metadata["gs:original_center_freq"] = self.current_center_freq
            global_metadata["gs:target_center_freq"] = self.target_center_freq

            # Add annotation documenting the frequency shift
            if self.total_samples > 0 and self.current_center_freq is not None:
                self.annotations.append(
                    {
                        "core:sample_start": 0,
                        "core:sample_count": self.total_samples,
                        "core:comment": f"Real-time frequency shift applied: {self.shift_hz} Hz. "
                        f"Original center: {self.current_center_freq/1e6:.3f} MHz, "
                        f"Target center: {self.target_center_freq/1e6:.3f} MHz. "
                        f"Signal now centered at {self.target_center_freq/1e6:.3f} MHz.",
                    }
                )

        # Add decimation metadata if applied
        if self.decimation_factor > 1:
            global_metadata["gs:decimation_factor"] = self.decimation_factor
            global_metadata["gs:original_sample_rate"] = self.current_input_sample_rate
            global_metadata["gs:decimated_sample_rate"] = self.current_sample_rate

            if (
                self.total_samples > 0
                and self.current_input_sample_rate
                and self.current_sample_rate
            ):
                self.annotations.append(
                    {
                        "core:sample_start": 0,
                        "core:sample_count": self.total_samples,
                        "core:comment": f"Real-time decimation applied: "
                        f"{self.decimation_factor}x "
                        f"(original {self.current_input_sample_rate/1e6:.3f} MS/s, "
                        f"recorded {self.current_sample_rate/1e6:.3f} MS/s).",
                    }
                )

        metadata = {
            "global": global_metadata,
            "captures": self.captures,
            "annotations": self.annotations,
        }

        with open(f"{self.recording_path}.sigmf-meta", "w") as f:
            json.dump(metadata, f, indent=2)

        logger.info(
            f"Metadata written: {len(self.captures)} capture(s), "
            f"{len(self.annotations)} annotation(s)"
        )
