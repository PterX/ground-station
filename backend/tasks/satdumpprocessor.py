"""
SatDump IQ recording processing task.

This task processes IQ recordings using SatDump with various satellite pipelines.
Supports progress tracking and graceful interruption.
"""

import re
import shutil
import signal
import subprocess
from multiprocessing import Queue
from pathlib import Path
from typing import Optional


class GracefulKiller:
    """Handle SIGTERM gracefully within the process."""

    def __init__(self):
        self.kill_now = False
        signal.signal(signal.SIGTERM, self.exit_gracefully)
        signal.signal(signal.SIGINT, self.exit_gracefully)

    def exit_gracefully(self, *args):
        self.kill_now = True


def _cleanup_empty_directory(directory: Path, progress_queue: Optional[Queue] = None):
    """
    Remove directory if it's empty or contains only empty subdirectories.

    Args:
        directory: Path to check and potentially remove
        progress_queue: Optional queue for logging
    """
    try:
        if not directory.exists():
            return

        # Check if directory has any files (recursively)
        has_files = any(directory.rglob("*"))

        if not has_files or _is_directory_empty(directory):
            if progress_queue:
                progress_queue.put(
                    {
                        "type": "output",
                        "output": f"Cleaning up empty output directory: {directory}",
                        "stream": "stdout",
                    }
                )
            shutil.rmtree(directory)
    except Exception as e:
        if progress_queue:
            progress_queue.put(
                {
                    "type": "output",
                    "output": f"Warning: Failed to clean up directory: {e}",
                    "stream": "stderr",
                }
            )


def _is_directory_empty(directory: Path) -> bool:
    """
    Check if directory is empty or contains only empty subdirectories.

    Args:
        directory: Path to check

    Returns:
        True if directory is empty or contains only empty subdirectories
    """
    if not directory.is_dir():
        return False

    for item in directory.iterdir():
        if item.is_file():
            return False
        if item.is_dir() and not _is_directory_empty(item):
            return False

    return True


def satdump_process_recording(
    recording_path: str,
    output_dir: str,
    satellite: str,
    samplerate: int = 0,
    baseband_format: str = "i16",
    start_timestamp: Optional[int] = None,
    finish_processing: bool = True,
    delete_input_after: bool = False,
    _progress_queue: Optional[Queue] = None,
):
    """
    Process an IQ recording with SatDump.

    Args:
        recording_path: Path to the input IQ recording file
        output_dir: Output directory for decoded products
        satellite: Satellite/pipeline identifier (e.g., 'meteor_m2-x_lrpt', 'noaa_apt')
        samplerate: Sample rate in Hz (0 = auto-detect from filename)
        baseband_format: Input format ('i16', 'i8', 'f32', 'w16', 'w8', etc.)
        start_timestamp: Unix timestamp for the recording start time
        finish_processing: Whether to run product generation after decoding
        _progress_queue: Queue for sending progress updates

    Returns:
        Dict with processing results
    """
    killer = GracefulKiller()

    # Resolve paths relative to backend/data directory
    backend_dir = Path(__file__).parent.parent

    recording_file = Path(recording_path)
    # Check if path starts with /recordings/ or /decoded/ (relative app paths)
    if not recording_file.exists():
        recording_file = backend_dir / "data" / recording_path.lstrip("/")

    output_path = Path(output_dir)
    if not output_path.is_absolute() or str(output_path).startswith("/decoded"):
        output_path = backend_dir / "data" / output_dir.lstrip("/")

    # Validate inputs
    if not recording_file.exists():
        error_msg = f"Recording file not found: {recording_file}"
        if _progress_queue:
            _progress_queue.put({"type": "error", "error": error_msg, "stream": "stderr"})
        raise FileNotFoundError(error_msg)

    # Create output directory
    output_dir_preexisted = output_path.exists()
    output_path.mkdir(parents=True, exist_ok=True)

    # Build SatDump command using resolved absolute paths
    cmd = [
        "satdump",
        "pipeline",
        satellite,
        "baseband",
        str(recording_file),
        str(output_path),
        "--samplerate",
        str(samplerate),
        "--baseband_format",
        baseband_format,
        "--fill_missing",
        "--dc_block",
    ]

    if start_timestamp:
        cmd.extend(["--start_timestamp", str(start_timestamp)])

    if finish_processing:
        cmd.append("--finish_processing")

    # Log command
    if _progress_queue:
        _progress_queue.put(
            {
                "type": "output",
                "output": "Starting SatDump processing",
                "stream": "stdout",
            }
        )
        _progress_queue.put(
            {
                "type": "output",
                "output": f"Satellite/Pipeline: {satellite}",
                "stream": "stdout",
            }
        )
        _progress_queue.put(
            {
                "type": "output",
                "output": f"Input: {recording_file}",
                "stream": "stdout",
            }
        )
        _progress_queue.put(
            {
                "type": "output",
                "output": f"Output: {output_path}",
                "stream": "stdout",
            }
        )
        _progress_queue.put(
            {"type": "output", "output": f"Command: {' '.join(cmd)}", "stream": "stdout"}
        )
        _progress_queue.put({"type": "output", "output": "-" * 60, "stream": "stdout"})

    try:
        # Start the subprocess
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            universal_newlines=True,
            bufsize=1,
        )

        # Stream output
        while True:
            # Check for graceful shutdown
            if killer.kill_now:
                if _progress_queue:
                    _progress_queue.put(
                        {
                            "type": "output",
                            "output": "Terminating SatDump process...",
                            "stream": "stdout",
                        }
                    )
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                return {"status": "interrupted", "message": "Process was interrupted"}

            # Read output
            if process.stdout:
                line = process.stdout.readline()
                if not line:
                    # Process finished
                    break
            else:
                break

            line = line.rstrip()
            line = re.sub(r"^\[\d{2}:\d{2}:\d{2}\s+-\s+\d{2}/\d{2}/\d{4}\]\s*", "", line)
            if line and _progress_queue:
                # Filter out debug (D) and trace (T) messages from SatDump
                if "(D)" in line or "(T)" in line:
                    continue

                # Filter out "Loading pipelines from file" messages
                if "Loading pipelines from file" in line:
                    continue

                # Parse progress from SatDump output
                progress = None
                if "Progress" in line or "%" in line:
                    # Try to extract percentage
                    try:
                        # Look for patterns like "Progress: 45.2%" or "[45%]"
                        match = re.search(r"(\d+(?:\.\d+)?)\s*%", line)
                        if match:
                            progress = float(match.group(1))
                    except Exception:
                        pass

                _progress_queue.put(
                    {
                        "type": "output",
                        "output": line,
                        "stream": "stdout",
                        "progress": progress if progress is not None else None,
                    }
                )

        # Wait for process to complete
        return_code = process.wait()

        # Check if output directory has any decoded products (images, data files)
        # SatDump v1.2.3 returns exit code 1 even when decoding succeeded
        has_images = False
        has_output = False
        if output_path.exists():
            # Check for any image files or data products
            has_images = (
                any(output_path.rglob("*.png"))
                or any(output_path.rglob("*.jpg"))
                or any(output_path.rglob("*.jpeg"))
            )
            has_output = has_images or any(output_path.rglob("product.cbor"))

        if delete_input_after:
            try:
                base_path = recording_file
                if base_path.name.endswith(".sigmf-data"):
                    base_path = base_path.with_suffix("")

                data_path = base_path.with_suffix(".sigmf-data")
                meta_path = base_path.with_suffix(".sigmf-meta")

                for path in (data_path, meta_path):
                    if path.exists():
                        path.unlink()

                if _progress_queue:
                    _progress_queue.put(
                        {
                            "type": "output",
                            "output": f"Deleted IQ recording: {data_path} (+.sigmf-meta)",
                            "stream": "stdout",
                        }
                    )
            except Exception as e:
                if _progress_queue:
                    _progress_queue.put(
                        {
                            "type": "output",
                            "output": f"Warning: Failed to delete IQ recording: {e}",
                            "stream": "stderr",
                        }
                    )

        if not has_images:
            if output_path.exists() and not output_dir_preexisted:
                if _progress_queue:
                    _progress_queue.put(
                        {
                            "type": "output",
                            "output": (
                                "No decoded images found; removing SatDump output directory"
                            ),
                            "stream": "stdout",
                        }
                    )
                shutil.rmtree(output_path)

            error_msg = "SatDump completed without decoded images"
            if _progress_queue:
                _progress_queue.put({"type": "error", "error": error_msg, "stream": "stderr"})
            raise RuntimeError(error_msg)

        if return_code == 0 or (return_code == 1 and has_output):
            if _progress_queue:
                _progress_queue.put(
                    {
                        "type": "output",
                        "output": "-" * 60,
                        "stream": "stdout",
                        "progress": 100,
                    }
                )
                if return_code == 1:
                    _progress_queue.put(
                        {
                            "type": "output",
                            "output": "SatDump completed with exit code 1 but products were generated successfully",
                            "stream": "stdout",
                        }
                    )
                else:
                    _progress_queue.put(
                        {
                            "type": "output",
                            "output": "SatDump processing completed successfully!",
                            "stream": "stdout",
                        }
                    )
                _progress_queue.put(
                    {
                        "type": "output",
                        "output": f"Output files saved to: {output_path}",
                        "stream": "stdout",
                    }
                )

            return {
                "status": "completed",
                "output_dir": str(output_path),
                "satellite": satellite,
                "return_code": return_code,
            }
        else:
            # Clean up empty output directory
            _cleanup_empty_directory(output_path, _progress_queue)

            error_msg = f"SatDump process failed with return code {return_code}"
            if _progress_queue:
                _progress_queue.put({"type": "error", "error": error_msg, "stream": "stderr"})
            raise RuntimeError(error_msg)

    except Exception as e:
        # Clean up empty output directory on exception
        _cleanup_empty_directory(output_path, _progress_queue)

        error_msg = f"Error during SatDump processing: {str(e)}"
        if _progress_queue:
            _progress_queue.put({"type": "error", "error": error_msg, "stream": "stderr"})
        raise
