"""Stream lifecycle management and cancellation support."""

import asyncio
import logging
from datetime import datetime
from typing import Dict, Optional

logger = logging.getLogger(__name__)


class StreamController:
    """
    Manages streaming state and cancellation for active sessions.

    Each stream has:
    - Unique stream_id
    - Cancellation event for graceful shutdown
    - State tracking (streaming, cancelling, completed)
    - Creation timestamp for timeout detection
    """

    def __init__(self):
        self._streams: Dict[str, asyncio.Event] = {}
        self._states: Dict[str, str] = {}
        self._timestamps: Dict[str, datetime] = {}

    def create_stream(self, stream_id: str) -> asyncio.Event:
        """
        Create a new stream with cancellation support.

        Args:
            stream_id: Unique identifier for this stream

        Returns:
            asyncio.Event that will be set when cancellation requested
        """
        cancel_event = asyncio.Event()
        self._streams[stream_id] = cancel_event
        self._states[stream_id] = "streaming"
        self._timestamps[stream_id] = datetime.utcnow()

        logger.info(f"Created stream {stream_id}")
        return cancel_event

    def cancel_stream(self, stream_id: str) -> bool:
        """
        Request cancellation of an active stream.

        Args:
            stream_id: Stream to cancel

        Returns:
            True if stream exists and cancellation requested
        """
        if stream_id in self._streams:
            self._streams[stream_id].set()
            self._states[stream_id] = "cancelling"
            logger.info(f"Cancelled stream {stream_id}")
            return True

        logger.warning(f"Cannot cancel stream {stream_id}: not found")
        return False

    def get_state(self, stream_id: str) -> Optional[str]:
        """Get current state of stream."""
        return self._states.get(stream_id)

    def is_cancelled(self, stream_id: str) -> bool:
        """Check if stream has been cancelled."""
        if stream_id in self._streams:
            return self._streams[stream_id].is_set()
        return False

    def cleanup_stream(self, stream_id: str):
        """Remove stream state after completion."""
        self._streams.pop(stream_id, None)
        self._states.pop(stream_id, None)
        self._timestamps.pop(stream_id, None)
        logger.info(f"Cleaned up stream {stream_id}")

    def list_active_streams(self) -> Dict[str, dict]:
        """Return all active streams with metadata."""
        return {
            stream_id: {
                "state": self._states.get(stream_id),
                "created": self._timestamps.get(stream_id).isoformat() if stream_id in self._timestamps else None,
                "cancelled": self._streams[stream_id].is_set()
            }
            for stream_id in self._streams
        }
