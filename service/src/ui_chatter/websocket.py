"""WebSocket connection management."""

from fastapi import WebSocket, status
from typing import Dict
import logging

from .exceptions import InvalidOriginError, ConnectionLimitError

logger = logging.getLogger(__name__)


class ConnectionManager:
    """
    Manages WebSocket connections with security and resource limits.

    Features:
    - Origin validation (chrome-extension:// only)
    - Connection limits
    - Automatic cleanup
    """

    def __init__(self, max_connections: int = 100):
        self.max_connections = max_connections
        self.active_connections: Dict[str, WebSocket] = {}

    async def connect(self, session_id: str, websocket: WebSocket) -> None:
        """
        Accept WebSocket connection with validation.

        Args:
            session_id: Unique session identifier
            websocket: FastAPI WebSocket instance

        Raises:
            InvalidOriginError: If origin is not chrome-extension://
            ConnectionLimitError: If max connections reached
        """
        # Validate origin (CRITICAL for security)
        origin = websocket.headers.get("origin", "")
        if not origin.startswith("chrome-extension://"):
            logger.warning(f"Rejected connection from invalid origin: {origin}")
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            raise InvalidOriginError(origin)

        # Check connection limit
        if len(self.active_connections) >= self.max_connections:
            logger.warning("Connection limit reached")
            await websocket.close(code=1008, reason="Server at capacity")
            raise ConnectionLimitError(self.max_connections)

        await websocket.accept()
        self.active_connections[session_id] = websocket
        logger.info(
            f"WebSocket connected: {session_id} (total: {len(self.active_connections)})"
        )

    def disconnect(self, session_id: str) -> None:
        """Remove connection."""
        self.active_connections.pop(session_id, None)
        logger.info(f"WebSocket disconnected: {session_id}")

    async def send_message(self, session_id: str, message: dict) -> None:
        """
        Send JSON message to specific session.

        Args:
            session_id: Session identifier
            message: Message dict to send
        """
        websocket = self.active_connections.get(session_id)
        if websocket:
            await websocket.send_json(message)
        else:
            logger.warning(f"Attempted to send to non-existent session: {session_id}")

    def get_connection_count(self) -> int:
        """Get number of active connections."""
        return len(self.active_connections)
