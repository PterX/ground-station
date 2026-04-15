# Ground Station - FM Demodulator
# Developed by Claude (Anthropic AI) for the Ground Station project
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


import logging
import queue
import threading
import time
from typing import Any, Dict, Optional, Tuple

import numpy as np
from scipy import signal

from common.audio_queue_config import get_audio_queue_config
from vfos.state import VFOManager

logger = logging.getLogger("fm-demodulator")


class FMDemodulator(threading.Thread):
    """
    FM demodulator that consumes IQ data and produces audio samples.

    This demodulator:
    1. Reads IQ samples from iq_queue (a subscriber queue from IQBroadcaster)
    2. Translates frequency based on VFO center frequency
    3. Decimates to appropriate bandwidth
    4. Demodulates FM using phase differentiation
    5. Applies de-emphasis filter
    6. Resamples to 44.1kHz audio
    7. Puts audio in audio_queue

    Note: Multiple demodulators can run simultaneously, each with its own
    subscriber queue from the IQBroadcaster. This allows multiple VFOs to
    process the same IQ samples without gaps.
    """

    def __init__(
        self,
        iq_queue,
        audio_queue,
        session_id,
        internal_mode=False,
        center_freq=None,
        bandwidth=None,
        vfo_number=None,
    ):
        super().__init__(daemon=True, name=f"FMDemodulator-{session_id}-VFO{vfo_number or ''}")
        self.iq_queue = iq_queue
        self.audio_queue = audio_queue
        self.session_id = session_id
        self.vfo_number = vfo_number  # VFO number for multi-VFO mode
        self.running = True
        self.vfo_manager = VFOManager()
        self.audio_cfg = get_audio_queue_config()

        # Internal mode: bypasses VFO checks and uses provided parameters
        self.internal_mode = internal_mode
        self.internal_center_freq = center_freq  # Used if internal_mode=True
        self.internal_bandwidth = bandwidth or 12500  # Default to 12.5 kHz for SSTV

        # Audio output parameters
        self.audio_sample_rate = 44100  # 44.1 kHz audio output
        self.target_chunk_size = 1024  # Minimum viable chunks for lowest latency (~23ms)

        # Audio buffer to accumulate samples
        self.audio_buffer = np.array([], dtype=np.float32)

        # Squelch state (for hysteresis)
        self.squelch_open = False  # Track if squelch is open (signal present)

        # Processing state
        self.last_sample = 0 + 0j
        self.sdr_sample_rate = None
        self.current_center_freq = None
        self.current_bandwidth = None

        # Filters (will be initialized when we know sample rates)
        self.decimation_filter: Optional[Tuple[np.ndarray, int]] = None
        self.audio_filter: Optional[np.ndarray] = None
        self.deemphasis_filter: Optional[Tuple[np.ndarray, np.ndarray]] = None

        # De-emphasis time constant (75 microseconds for US, 50 for EU)
        self.deemphasis_tau = 75e-6

        # Power measurement settings
        self.power_update_rate = 4.0  # Hz - send power measurements 4 times per second
        self.last_power_time = 0.0
        self.last_rf_power_db = None  # Cache last measured power

        # Performance monitoring stats
        self.stats: Dict[str, Any] = {
            "iq_chunks_in": 0,
            "iq_samples_in": 0,
            "audio_chunks_out": 0,
            "audio_samples_out": 0,
            "queue_timeouts": 0,
            "last_activity": None,
            "errors": 0,
            # Ingest-side flow metrics (updated every ~1s)
            "ingest_samples_per_sec": 0.0,
            "ingest_chunks_per_sec": 0.0,
            # Out-of-band accounting
            "samples_dropped_out_of_band": 0,
            # Sleeping state (VFO out of SDR bandwidth)
            "is_sleeping": False,
        }
        self.stats_lock = threading.Lock()

        # Track sleeping state (mirror in stats["is_sleeping"])
        self.is_sleeping = False
        self.sleep_reason = None

    def _get_active_vfo(self):
        """Get VFO state for this demodulator's VFO."""
        if self.vfo_number is None:
            logger.error(f"vfo_number is required for FMDemodulator (session {self.session_id})")
            return None

        vfo_state = self.vfo_manager.get_vfo_state(self.session_id, self.vfo_number)
        if vfo_state and vfo_state.active:
            return vfo_state
        return None

    def _resize_filter_state(self, old_state, b_coeffs, initial_value, a_coeffs=None):
        """
        Resize filter state vector when filter coefficients change.

        This prevents clicks by smoothly transitioning filter states instead of
        resetting to None when bandwidth changes.

        Args:
            old_state: Previous filter state (or None)
            b_coeffs: New numerator coefficients
            initial_value: Value to use for initialization if needed
            a_coeffs: Denominator coefficients (for IIR filters)

        Returns:
            Resized filter state appropriate for the new filter
        """
        if a_coeffs is None:
            # FIR filter: state length is len(b) - 1
            new_len = len(b_coeffs) - 1
        else:
            # IIR filter: state length is max(len(b), len(a)) - 1
            new_len = max(len(b_coeffs), len(a_coeffs)) - 1

        if old_state is None or len(old_state) == 0:
            # No previous state, initialize fresh
            if a_coeffs is None:
                return signal.lfilter_zi(b_coeffs, 1) * initial_value
            else:
                return signal.lfilter_zi(b_coeffs, a_coeffs) * initial_value

        old_len = len(old_state)

        if old_len == new_len:
            # Same size, keep the state as-is
            return old_state
        elif new_len > old_len:
            # Need more state - pad with zeros or the last value
            # Use the last state value to avoid discontinuities
            pad_value = old_state[-1] if old_len > 0 else 0
            padding = np.full(new_len - old_len, pad_value)
            return np.concatenate([old_state, padding])
        else:
            # Need less state - truncate
            return old_state[:new_len]

    def _design_decimation_filter(self, sdr_rate, bandwidth):
        """Design cascaded decimation filters for efficient multi-stage decimation.

        Uses cascaded low-order (4th) IIR filters to avoid numerical instability
        while providing good anti-aliasing at high decimation ratios.
        """
        # Calculate decimation factor to get to ~200 kHz intermediate rate
        target_rate = 200e3
        total_decimation = int(sdr_rate / target_rate)
        total_decimation = max(1, total_decimation)

        # For high decimation ratios, use 2-stage cascaded decimation
        # This avoids numerical instability and provides better anti-aliasing
        stages = []

        if total_decimation <= 10:
            # Single stage for low decimation
            nyquist = sdr_rate / 2.0
            cutoff = bandwidth / 2.0
            normalized_cutoff = min(0.4, max(0.01, cutoff / nyquist))
            b, a = signal.butter(4, normalized_cutoff, btype="low")
            stages.append(((b, a), total_decimation))
        else:
            # Two-stage cascaded decimation for better anti-aliasing
            # Stage 1: Decimate by 5
            stage1_decimation = 5
            nyquist1 = sdr_rate / 2.0
            # Cutoff at 80% of post-stage1 Nyquist for anti-aliasing
            cutoff1 = (sdr_rate / stage1_decimation) * 0.4
            normalized_cutoff1 = min(0.4, max(0.01, cutoff1 / nyquist1))
            b1, a1 = signal.butter(4, normalized_cutoff1, btype="low")
            stages.append(((b1, a1), stage1_decimation))

            # Stage 2: Decimate by remaining factor
            stage2_decimation = total_decimation // stage1_decimation
            if stage2_decimation > 1:
                rate_after_stage1 = sdr_rate / stage1_decimation
                nyquist2 = rate_after_stage1 / 2.0
                # Final cutoff is bandwidth-limited
                cutoff2 = min(bandwidth / 2.0, (rate_after_stage1 / stage2_decimation) * 0.4)
                normalized_cutoff2 = min(0.4, max(0.01, cutoff2 / nyquist2))
                b2, a2 = signal.butter(4, normalized_cutoff2, btype="low")
                stages.append(((b2, a2), stage2_decimation))

        return stages, total_decimation

    def _design_audio_filter(self, intermediate_rate, vfo_bandwidth):
        """Design audio low-pass filter based on VFO bandwidth.

        For FM, the audio bandwidth is derived from the RF bandwidth:
        - Narrow FM (< 25 kHz): ~3-5 kHz audio (voice)
        - Medium FM (25-100 kHz): scaled proportionally
        - Wide FM (> 100 kHz): ~15 kHz audio (broadcast/music)
        """
        # Calculate audio cutoff based on VFO bandwidth
        # Use a reasonable fraction of the RF bandwidth for audio
        if vfo_bandwidth < 25e3:
            # Narrowband FM: limit to voice bandwidth
            cutoff = min(3e3, vfo_bandwidth * 0.3)
        elif vfo_bandwidth < 100e3:
            # Medium bandwidth: scale proportionally
            cutoff = vfo_bandwidth * 0.15
        else:
            # Wideband FM: allow up to 15 kHz for music
            cutoff = min(15e3, vfo_bandwidth * 0.15)

        # Ensure minimum cutoff frequency
        cutoff = max(cutoff, 500)  # At least 500 Hz

        nyquist = intermediate_rate / 2.0
        normalized_cutoff = cutoff / nyquist

        # Ensure normalized cutoff is valid (0 < f < 1)
        normalized_cutoff = min(0.45, max(0.01, normalized_cutoff))

        numtaps = 101
        filter_taps = signal.firwin(numtaps, normalized_cutoff, window="hamming")

        return filter_taps

    def _design_deemphasis_filter(self, sample_rate):
        """Design de-emphasis filter for FM broadcast."""
        # De-emphasis filter: H(s) = 1 / (1 + s * tau)
        # Bilinear transform to digital filter
        tau = self.deemphasis_tau
        omega = 1.0 / tau
        b, a = signal.bilinear([1], [1 / omega, 1], sample_rate)
        return (b, a)

    def _frequency_translate(self, samples, offset_freq, sample_rate):
        """Translate frequency by offset (shift signal in frequency domain)."""
        if offset_freq == 0:
            return samples

        # Generate complex exponential for frequency shift
        t = np.arange(len(samples)) / sample_rate
        shift = np.exp(-2j * np.pi * offset_freq * t)
        return samples * shift

    def _fm_demodulate(self, samples):
        """
        Demodulate FM using phase differentiation.

        The instantaneous frequency is the derivative of the phase.
        For complex samples: angle(s[n] * conj(s[n-1]))
        """
        # Compute phase difference
        diff = samples[1:] * np.conj(samples[:-1])
        demodulated = np.angle(diff)

        # Prepend last sample state for continuity
        if self.last_sample is not None:
            first_diff = samples[0] * np.conj(self.last_sample)
            demodulated = np.concatenate(([np.angle(first_diff)], demodulated))
        else:
            demodulated = np.concatenate(([0], demodulated))

        # Save last sample for next iteration
        self.last_sample = samples[-1]

        return demodulated

    def _is_vfo_in_sdr_bandwidth(
        self, vfo_center: float, sdr_center: float, sdr_sample_rate: float
    ):
        """
        Check if VFO center frequency is within SDR bandwidth (with small edge margin).

        Returns tuple: (is_in_band, offset_from_sdr_center, margin_hz)
        """
        offset = vfo_center - sdr_center
        half_sdr_bandwidth = sdr_sample_rate / 2.0
        usable_bandwidth = half_sdr_bandwidth * 0.98  # 2% margin for roll-off
        is_in_band = abs(offset) <= usable_bandwidth
        margin_hz = usable_bandwidth - abs(offset)
        return is_in_band, offset, margin_hz

    def run(self):
        """Main demodulator loop."""
        logger.info(f"FM demodulator started for session {self.session_id}")

        # State for filter applications
        decimation_state = None
        audio_filter_state = None
        deemph_state = None

        # Ingest-rate tracking and stats heartbeat
        ingest_window_start = time.time()
        ingest_samples_accum = 0
        ingest_chunks_accum = 0
        last_stats_time = time.time()

        while self.running:
            try:
                # CRITICAL: Always drain iq_queue to prevent buffer buildup
                # Even if VFO is inactive, we must consume samples to avoid lag
                if self.iq_queue.empty():
                    time.sleep(0.01)
                    continue

                iq_message = self.iq_queue.get(timeout=0.1)

                # Update stats
                with self.stats_lock:
                    self.stats["iq_chunks_in"] += 1
                    self.stats["last_activity"] = time.time()

                # Extract samples and metadata first
                samples = iq_message.get("samples")
                sdr_center_freq = iq_message.get(
                    "logical_center_freq_hz", iq_message.get("center_freq")
                )
                sdr_sample_rate = iq_message.get("sample_rate")

                if samples is None or len(samples) == 0:
                    continue

                # Update sample count and ingest accumulators
                with self.stats_lock:
                    self.stats["iq_samples_in"] += len(samples)
                ingest_samples_accum += len(samples)
                ingest_chunks_accum += 1

                # Determine VFO parameters based on mode
                if self.internal_mode:
                    # Internal mode: use provided parameters but still get VFO state for volume/squelch/bandwidth/frequency
                    vfo_state = self._get_active_vfo()
                    # Use VFO center frequency if available (allows dynamic tuning), otherwise fallback to internal/SDR center
                    if vfo_state and vfo_state.center_freq:
                        vfo_center_freq = vfo_state.center_freq
                    elif self.internal_center_freq is not None:
                        vfo_center_freq = self.internal_center_freq
                    else:
                        vfo_center_freq = sdr_center_freq
                    # Use VFO bandwidth if available (allows dynamic bandwidth adjustment), otherwise fallback to internal
                    vfo_bandwidth = vfo_state.bandwidth if vfo_state else self.internal_bandwidth
                else:
                    # Normal mode: check VFO state
                    vfo_state = self._get_active_vfo()
                    if not vfo_state:
                        # VFO inactive - discard these samples and continue
                        continue

                    # Check if modulation is FM
                    if vfo_state.modulation.lower() != "fm":
                        # Wrong modulation - discard these samples and continue
                        continue

                    vfo_center_freq = vfo_state.center_freq
                    vfo_bandwidth = vfo_state.bandwidth

                # Check if we need to reinitialize filters
                if (
                    self.sdr_sample_rate != sdr_sample_rate
                    or self.current_bandwidth != vfo_bandwidth
                    or self.decimation_filter is None
                ):
                    self.sdr_sample_rate = sdr_sample_rate
                    self.current_bandwidth = vfo_bandwidth

                    # Design filters
                    stages, total_decimation = self._design_decimation_filter(
                        sdr_sample_rate, vfo_bandwidth
                    )
                    self.decimation_filter = (stages, total_decimation)

                    intermediate_rate = sdr_sample_rate / total_decimation
                    self.audio_filter = self._design_audio_filter(intermediate_rate, vfo_bandwidth)
                    self.deemphasis_filter = self._design_deemphasis_filter(intermediate_rate)

                    # Initialize filter states for each stage
                    initial_value = samples[0] if len(samples) > 0 else 0
                    decimation_state = []
                    for (b, a), _ in stages:
                        state = signal.lfilter_zi(b, a) * initial_value
                        decimation_state.append(state)

                    # Initialize audio filter states
                    audio_filter_state = self._resize_filter_state(
                        audio_filter_state, self.audio_filter, 0
                    )
                    b_deemph, a_deemph = self.deemphasis_filter  # type: ignore[misc]
                    deemph_state = self._resize_filter_state(deemph_state, b_deemph, 0, a_deemph)

                    logger.info(
                        f"Filters initialized (internal_mode={self.internal_mode}): SDR rate={sdr_sample_rate/1e6:.2f} MHz, "
                        f"stages={len(stages)}, total_decimation={total_decimation}, "
                        f"intermediate={intermediate_rate/1e3:.1f} kHz"
                    )

                # Step 1: Frequency translation (tune to VFO frequency)
                # Skip if VFO frequency is not set (0 or invalid)
                if vfo_center_freq == 0:
                    logger.debug("VFO frequency not set, skipping frame")
                    continue

                # Validate VFO center is within SDR bandwidth (with edge margin)
                is_in_band, vfo_offset, margin = self._is_vfo_in_sdr_bandwidth(
                    vfo_center_freq, sdr_center_freq, sdr_sample_rate
                )

                if not is_in_band:
                    # VFO is outside SDR bandwidth - enter sleeping state, skip DSP for this chunk
                    with self.stats_lock:
                        self.stats["samples_dropped_out_of_band"] += len(samples)
                    if not self.is_sleeping:
                        self.is_sleeping = True
                        self.sleep_reason = (
                            f"VFO out of SDR bandwidth: VFO={vfo_center_freq/1e6:.3f}MHz, "
                            f"SDR={sdr_center_freq/1e6:.3f}MHz±{(sdr_sample_rate/2)/1e6:.2f}MHz, "
                            f"offset={vfo_offset/1e3:.1f}kHz, exceeded by {abs(margin)/1e3:.1f}kHz"
                        )
                        logger.warning(self.sleep_reason)
                    # Mirror sleeping state into stats
                    with self.stats_lock:
                        self.stats["is_sleeping"] = True
                    continue

                # If we were sleeping and now back in band, resume
                if self.is_sleeping:
                    self.is_sleeping = False
                    with self.stats_lock:
                        self.stats["is_sleeping"] = False
                    logger.info(
                        f"VFO back in SDR bandwidth, resuming FM demodulation: VFO={vfo_center_freq/1e6:.3f}MHz, "
                        f"SDR={sdr_center_freq/1e6:.3f}MHz, offset={vfo_offset/1e3:.1f}kHz"
                    )

                offset_freq = vfo_center_freq - sdr_center_freq

                translated = self._frequency_translate(samples, offset_freq, sdr_sample_rate)

                # Step 2: Multi-stage cascaded decimation
                stages, total_decimation = self.decimation_filter

                # Apply each stage sequentially
                decimated = translated
                for stage_idx, ((b, a), stage_decimation) in enumerate(stages):
                    # Initialize state if needed
                    if decimation_state is None or stage_idx >= len(decimation_state):
                        # Should not happen if properly initialized, but safety check
                        if decimation_state is None:
                            decimation_state = []
                        decimation_state.append(signal.lfilter_zi(b, a) * decimated[0])

                    # Apply IIR filter
                    filtered, decimation_state[stage_idx] = signal.lfilter(
                        b, a, decimated, zi=decimation_state[stage_idx]
                    )

                    # Decimate
                    decimated = filtered[::stage_decimation]

                # Measure RF signal power for squelch AFTER filtering (within VFO bandwidth)
                # Calculate on every chunk for accurate squelch operation
                signal_power = np.mean(np.abs(decimated) ** 2)
                rf_power_db_raw = 10 * np.log10(signal_power + 1e-10)

                # Empirical calibration offset to match waterfall display
                # Adjusted based on testing to align with FFT waterfall levels
                # Target: FFT noise floor -73dB matches FM demod -73dB
                calibration_offset_db = 17.0

                rf_power_db = rf_power_db_raw + calibration_offset_db

                # Update cached power value periodically for UI updates (throttled to N Hz)
                current_time = time.time()
                should_update_ui_power = (current_time - self.last_power_time) >= (
                    1.0 / self.power_update_rate
                )

                if should_update_ui_power:
                    self.last_rf_power_db = rf_power_db
                    self.last_power_time = current_time

                intermediate_rate = sdr_sample_rate / total_decimation

                # Step 3: FM demodulation
                demodulated = self._fm_demodulate(decimated)

                # Step 4: Audio filtering
                if audio_filter_state is None:
                    # Initialize filter state on first run
                    audio_filter_state = signal.lfilter_zi(self.audio_filter, 1) * demodulated[0]

                audio_filtered, audio_filter_state = signal.lfilter(
                    self.audio_filter, 1, demodulated, zi=audio_filter_state
                )

                # Step 5: De-emphasis
                b, a = self.deemphasis_filter  # type: ignore[misc]

                if deemph_state is None:
                    # Initialize filter state on first run
                    deemph_state = signal.lfilter_zi(b, a) * audio_filtered[0]

                deemphasized, deemph_state = signal.lfilter(b, a, audio_filtered, zi=deemph_state)

                # Step 6: Resample to audio rate (44.1 kHz)
                num_output_samples = int(
                    len(deemphasized) * self.audio_sample_rate / intermediate_rate
                )
                if num_output_samples > 0:
                    audio = signal.resample(deemphasized, num_output_samples)

                    # Apply amplification to boost low audio levels
                    # Adjust this gain factor if audio is still too quiet or too loud
                    audio_gain = 3.0  # 3x amplification (adjustable)
                    audio = audio * audio_gain

                    # Soft clipping instead of normalization (preserves relative levels)
                    # Only clip values that exceed [-1, 1] range
                    audio = np.clip(audio, -0.95, 0.95)

                    # NOTE: Volume is applied by WebAudioStreamer, not here
                    # This allows per-session volume control

                    # Apply squelch based on RF signal strength (measured earlier)
                    # Get squelch threshold from VFO state (works in both normal and internal mode)
                    if self.internal_mode:
                        # In internal mode, get VFO state for squelch settings
                        vfo_state_for_squelch = self._get_active_vfo()
                        if vfo_state_for_squelch:
                            squelch_threshold_db = vfo_state_for_squelch.squelch
                        else:
                            squelch_threshold_db = -200  # Fallback if no VFO state
                    else:
                        squelch_threshold_db = vfo_state.squelch  # e.g., -150 dB

                    squelch_hysteresis_db = 3  # 3 dB hysteresis to prevent flutter

                    # Apply squelch with hysteresis
                    if self.squelch_open:
                        # Squelch is open - close if RF power drops below (threshold - hysteresis)
                        if rf_power_db < (squelch_threshold_db - squelch_hysteresis_db):
                            self.squelch_open = False
                            audio = np.zeros_like(audio)  # Mute
                    else:
                        # Squelch is closed - open if RF power rises above (threshold + hysteresis)
                        if rf_power_db > (squelch_threshold_db + squelch_hysteresis_db):
                            self.squelch_open = True
                            # Let audio through
                        else:
                            audio = np.zeros_like(audio)  # Keep muted

                    # Convert to float32
                    audio = audio.astype(np.float32)

                    # Buffer audio samples to create consistent chunk sizes
                    self.audio_buffer = np.concatenate([self.audio_buffer, audio])

                    # CRITICAL: Limit buffer size to prevent unbounded growth
                    # If buffer grows too large (>10 chunks), drop oldest data
                    max_buffer_samples = (
                        self.target_chunk_size * self.audio_cfg.demod_audio_internal_buffer_chunks
                    )
                    if len(self.audio_buffer) > max_buffer_samples:
                        # Keep only the most recent data
                        self.audio_buffer = self.audio_buffer[-max_buffer_samples:]
                        # Only log warning if not in internal mode (used by decoders like SSTV)
                        if not self.internal_mode:
                            logger.warning(
                                f"Audio buffer overflow ({len(self.audio_buffer)} samples), "
                                f"dropping old audio to prevent lag buildup"
                            )
                        else:
                            logger.debug(
                                f"Audio buffer overflow ({len(self.audio_buffer)} samples), "
                                f"dropping old audio (internal mode)"
                            )

                    # Send chunks of target size when buffer is full enough
                    while len(self.audio_buffer) >= self.target_chunk_size:
                        # Extract a chunk
                        chunk = self.audio_buffer[: self.target_chunk_size]
                        self.audio_buffer = self.audio_buffer[self.target_chunk_size :]

                        # Prepare audio message with RF power measurement
                        audio_message = {
                            "session_id": self.session_id,
                            "audio": chunk,
                            "vfo_number": self.vfo_number,  # Tag audio with VFO number
                            "rf_power_db": self.last_rf_power_db,  # Include latest power measurement
                        }

                        # Always output audio (UI handles muting, transcription always active)
                        # Put audio chunk in queue (single output point)
                        # In internal mode, this feeds AudioBroadcaster which distributes to decoder/UI
                        # In normal mode, this goes directly to audio consumers
                        try:
                            self.audio_queue.put_nowait(audio_message)
                            # Update stats
                            with self.stats_lock:
                                self.stats["audio_chunks_out"] += 1
                                self.stats["audio_samples_out"] += len(chunk)
                        except queue.Full:
                            # Queue is full - drop this chunk to prevent lag accumulation
                            logger.debug(
                                f"Audio queue full, dropping chunk for session {self.session_id}"
                            )
                            break  # Exit while loop to process next IQ samples
                        except Exception as e:
                            logger.warning(f"Could not queue audio: {str(e)}")
                            break

            except Exception as e:
                if self.running:
                    logger.error(f"Error in FM demodulator: {str(e)}")
                    logger.exception(e)
                    with self.stats_lock:
                        self.stats["errors"] += 1
                time.sleep(0.1)
            finally:
                # Time-based stats tick (every ~1s), compute ingest rates regardless of processing state
                now = time.time()
                if now - last_stats_time >= 1.0:
                    dt = now - ingest_window_start
                    if dt > 0:
                        ingest_sps = ingest_samples_accum / dt
                        ingest_cps = ingest_chunks_accum / dt
                    else:
                        ingest_sps = 0.0
                        ingest_cps = 0.0

                    with self.stats_lock:
                        self.stats["ingest_samples_per_sec"] = ingest_sps
                        self.stats["ingest_chunks_per_sec"] = ingest_cps
                        # Keep stats["is_sleeping"] in sync with attribute
                        self.stats["is_sleeping"] = self.is_sleeping

                    # Reset window
                    ingest_window_start = now
                    ingest_samples_accum = 0
                    ingest_chunks_accum = 0

                    # Advance the stats tick reference to avoid re-triggering every loop
                    last_stats_time = now

        logger.info(f"FM demodulator stopped for session {self.session_id}")

    def stop(self):
        """Stop the demodulator thread."""
        self.running = False
