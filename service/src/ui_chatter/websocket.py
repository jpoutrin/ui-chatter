"""WebSocket connection management."""

import asyncio
from fastapi import WebSocket, status
from typing import Dict, Optional
import logging
import json

from .exceptions import InvalidOriginError, ConnectionLimitError

logger = logging.getLogger(__name__)


class ConnectionManager:
    """
    Manages WebSocket connections with security and resource limits.

    Features:
    - Origin validation (chrome-extension:// only)
    - Connection limits
    - Automatic cleanup
    - Debug message logging
    - Ping/pong keepalive
    """

    def __init__(
        self,
        max_connections: int = 100,
        ping_interval: int = 20,
        ping_timeout: int = 10
    ):
        self.max_connections = max_connections
        self.ping_interval = ping_interval  # seconds between pings
        self.ping_timeout = ping_timeout  # seconds to wait for pong
        self.active_connections: Dict[str, WebSocket] = {}
        self.ping_tasks: Dict[str, asyncio.Task] = {}
        self.receiver_tasks: Dict[str, asyncio.Task] = {}  # Background receiver tasks
        self.message_queues: Dict[str, asyncio.Queue] = {}  # Message queues
        self.last_pong_time: Dict[str, float] = {}  # Track last pong receipt
        self.pong_events: Dict[str, asyncio.Event] = {}  # Signal pong receipt

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
        """Remove connection and cancel background tasks."""
        self.active_connections.pop(session_id, None)

        # Cancel ping task if exists
        ping_task = self.ping_tasks.pop(session_id, None)
        if ping_task:
            ping_task.cancel()

        # Cancel receiver task if exists
        receiver_task = self.receiver_tasks.pop(session_id, None)
        if receiver_task:
            receiver_task.cancel()

        # Clean up message queue
        self.message_queues.pop(session_id, None)

        # Clean up pong tracking
        self.pong_events.pop(session_id, None)
        self.last_pong_time.pop(session_id, None)

        logger.info(f"WebSocket disconnected: {session_id}")

    async def send_message(self, session_id: str, message: dict) -> None:
        """
        Send JSON message to specific session with debug logging.

        Args:
            session_id: Session identifier
            message: Message dict to send
        """
        websocket = self.active_connections.get(session_id)
        if websocket:
            # Debug logging for outgoing messages
            msg_type = message.get("type", "unknown")
            logger.debug(f"[WS OUT] {session_id[:8]}... | {msg_type} | {json.dumps(message)[:200]}")
            await websocket.send_json(message)
        else:
            logger.warning(f"Attempted to send to non-existent session: {session_id}")

    def get_connection_count(self) -> int:
        """Get number of active connections."""
        return len(self.active_connections)

    def mark_pong_received(self, session_id: str) -> None:
        """Mark that a pong was received for this session."""
        import time
        self.last_pong_time[session_id] = time.time()
        if session_id in self.pong_events:
            self.pong_events[session_id].set()
        logger.debug(f"[WS PONG] {session_id[:8]}... | Pong received")

    async def _ping_loop(self, session_id: str) -> None:
        """
        Background task to send periodic pings and enforce pong timeouts.

        Args:
            session_id: Session to ping
        """
        try:
            while True:
                await asyncio.sleep(self.ping_interval)

                websocket = self.active_connections.get(session_id)
                if not websocket:
                    break

                # Create event for this ping
                pong_event = asyncio.Event()
                self.pong_events[session_id] = pong_event

                try:
                    # Send ping
                    logger.debug(f"[WS PING] {session_id[:8]}... | Sending ping")
                    await websocket.send_json({"type": "ping"})

                    # Wait for pong with timeout
                    try:
                        await asyncio.wait_for(
                            pong_event.wait(),
                            timeout=self.ping_timeout
                        )
                    except asyncio.TimeoutError:
                        logger.warning(
                            f"[WS PING] {session_id[:8]}... | No pong in "
                            f"{self.ping_timeout}s, closing"
                        )
                        await websocket.close(code=1000, reason="Ping timeout")
                        break

                except Exception as e:
                    logger.warning(f"Ping failed for {session_id}: {e}")
                    break
                finally:
                    self.pong_events.pop(session_id, None)

        except asyncio.CancelledError:
            logger.debug(f"Ping task cancelled for {session_id}")
        finally:
            self.pong_events.pop(session_id, None)
            self.last_pong_time.pop(session_id, None)

    def start_ping(self, session_id: str) -> None:
        """Start ping keepalive task for a session."""
        if session_id not in self.ping_tasks:
            task = asyncio.create_task(self._ping_loop(session_id))
            self.ping_tasks[session_id] = task
            logger.debug(f"Started ping task for session {session_id}")

    async def _receiver_loop(self, session_id: str, websocket: WebSocket, receive_timeout: int) -> None:
        """
        Background task to continuously receive messages from WebSocket.

        This task runs independently of message processing, ensuring that
        pong messages are handled immediately even when Claude is thinking.

        Args:
            session_id: Session identifier
            websocket: WebSocket connection
            receive_timeout: Maximum time to wait for a message
        """
        try:
            while True:
                try:
                    # Receive message with timeout
                    data = await asyncio.wait_for(
                        websocket.receive_json(),
                        timeout=receive_timeout
                    )

                    # Handle pong immediately (critical for keepalive)
                    if data.get("type") == "pong":
                        self.mark_pong_received(session_id)
                        # Don't queue pongs - they're handled here
                        continue

                    # Queue all other messages for processing
                    queue = self.message_queues.get(session_id)
                    if queue:
                        await queue.put(data)

                except asyncio.TimeoutError:
                    logger.warning(
                        f"[WS RECEIVER] {session_id[:8]}... | No message in "
                        f"{receive_timeout}s, closing"
                    )
                    await websocket.close(code=1000, reason="Receive timeout")
                    break

        except asyncio.CancelledError:
            logger.debug(f"Receiver task cancelled for {session_id}")
        except Exception as e:
            logger.error(f"Receiver error for {session_id}: {e}")
            # Signal error by putting None in queue
            queue = self.message_queues.get(session_id)
            if queue:
                await queue.put(None)

    def start_receiver(self, session_id: str, websocket: WebSocket, receive_timeout: int = 300) -> None:
        """
        Start background receiver task for a session.

        Args:
            session_id: Session identifier
            websocket: WebSocket connection
            receive_timeout: Maximum time to wait for a message (seconds)
        """
        if session_id not in self.receiver_tasks:
            # Create message queue
            self.message_queues[session_id] = asyncio.Queue()

            # Start receiver task
            task = asyncio.create_task(
                self._receiver_loop(session_id, websocket, receive_timeout)
            )
            self.receiver_tasks[session_id] = task
            logger.debug(f"Started receiver task for session {session_id}")

    async def receive_message(self, session_id: str, timeout: Optional[float] = None) -> Optional[dict]:
        """
        Receive next message from the queue for this session.

        Args:
            session_id: Session identifier
            timeout: Optional timeout in seconds

        Returns:
            Message dict or None if connection closed or error occurred
        """
        queue = self.message_queues.get(session_id)
        if not queue:
            return None

        try:
            if timeout:
                return await asyncio.wait_for(queue.get(), timeout=timeout)
            else:
                return await queue.get()
        except asyncio.TimeoutError:
            raise  # Let caller handle timeout
