"""WebSocket connection management."""

import asyncio
from fastapi import WebSocket, status
from typing import Any, Dict, Optional, TYPE_CHECKING

from .types import WebSocketMessage

if TYPE_CHECKING:
    from .stream_controller import StreamController
import logging
import json

from .exceptions import InvalidOriginError, ConnectionLimitError
from .session_store import SessionStore

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
        ping_timeout: int = 10,
        session_store: Optional[SessionStore] = None,
        stream_controller: Optional['StreamController'] = None
    ):
        self.max_connections = max_connections
        self.ping_interval = ping_interval  # seconds between pings
        self.ping_timeout = ping_timeout  # seconds to wait for pong
        self.active_connections: Dict[str, WebSocket] = {}
        self.ping_tasks: Dict[str, asyncio.Task[None]] = {}
        self.receiver_tasks: Dict[str, asyncio.Task[None]] = {}  # Background receiver tasks
        self.message_queues: Dict[str, asyncio.Queue[Optional[WebSocketMessage]]] = {}  # Message queues
        self.last_pong_time: Dict[str, float] = {}  # Track last pong receipt
        self.pong_events: Dict[str, asyncio.Event] = {}  # Signal pong receipt
        self.session_store = session_store
        self.stream_controller = stream_controller

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

    def migrate_session(self, old_session_id: str, new_session_id: str) -> None:
        """
        Migrate a session from one ID to another.

        This is used after handshake when "temp" becomes a real session_id.

        Args:
            old_session_id: Current session ID (e.g., "temp")
            new_session_id: New session ID to migrate to
        """
        # Migrate connection
        websocket = self.active_connections.pop(old_session_id, None)
        if websocket:
            self.active_connections[new_session_id] = websocket

        # Cancel old ping task and start new one with correct session_id
        ping_task = self.ping_tasks.pop(old_session_id, None)
        if ping_task:
            ping_task.cancel()
        if websocket:
            self.start_ping(new_session_id)

        # Cancel old receiver task and start new one with correct session_id
        # This is CRITICAL - the receiver task's session_id parameter must match
        # the message queue key, or messages won't be queued!
        receiver_task = self.receiver_tasks.pop(old_session_id, None)
        receive_timeout = 300  # Default timeout
        if receiver_task:
            receiver_task.cancel()
        if websocket:
            # Create new message queue for new session_id
            self.message_queues[new_session_id] = asyncio.Queue()
            # Start new receiver with new session_id
            task = asyncio.create_task(
                self._receiver_loop(new_session_id, websocket, receive_timeout)
            )
            self.receiver_tasks[new_session_id] = task

        # Migrate pong tracking
        pong_event = self.pong_events.pop(old_session_id, None)
        if pong_event:
            self.pong_events[new_session_id] = pong_event

        last_pong = self.last_pong_time.pop(old_session_id, None)
        if last_pong:
            self.last_pong_time[new_session_id] = last_pong

        # Clean up old message queue
        self.message_queues.pop(old_session_id, None)

        logger.info(f"Session migrated: {old_session_id} -> {new_session_id}")

    async def send_message(self, session_id: str, message: WebSocketMessage) -> bool:
        """
        Send JSON message to specific session with debug logging.

        Args:
            session_id: Session identifier
            message: Message dict to send

        Returns:
            True if message was sent successfully, False otherwise
        """
        websocket = self.active_connections.get(session_id)
        if not websocket:
            logger.warning(f"Attempted to send to non-existent session: {session_id}")
            return False

        try:
            # Debug logging for outgoing messages
            msg_type = message.get("type", "unknown")
            logger.debug(f"[WS OUT] {session_id[:8]}... | {msg_type} | {json.dumps(message)[:200]}")
            await websocket.send_json(message)
            return True
        except RuntimeError as e:
            # Handle "Unexpected ASGI message" errors when connection is already closed
            if "websocket.send" in str(e) or "websocket.close" in str(e):
                logger.warning(f"Cannot send message to {session_id}: connection already closed")
                # Clean up the dead connection
                self.disconnect(session_id)
                return False
            raise
        except Exception as e:
            logger.error(f"Error sending message to {session_id}: {e}")
            return False

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
        print(f"✓ Receiver loop started for {session_id}")
        try:
            while True:
                try:
                    # Receive message with timeout
                    data = await asyncio.wait_for(
                        websocket.receive_json(),
                        timeout=receive_timeout
                    )

                    print(f"RECEIVER [{session_id}]: Got message type: {data.get('type')}")

                    # Handle pong immediately (critical for keepalive)
                    if data.get("type") == "pong":
                        self.mark_pong_received(session_id)
                        # Don't queue pongs - they're handled here
                        continue

                    # Handle cancel_request immediately (critical for responsiveness)
                    if data.get("type") == "cancel_request":
                        stream_id = data.get("stream_id")
                        if stream_id and self.stream_controller:
                            success = self.stream_controller.cancel_stream(stream_id)
                            logger.info(f"[WS RECEIVER] Immediate cancel for stream {stream_id}: {'success' if success else 'failed'}")
                            # Send acknowledgment directly
                            await self.send_message(
                                session_id,
                                {
                                    "type": "status",
                                    "status": "cancelled" if success else "error",
                                    "detail": "Stream cancelled" if success else "Stream not found"
                                }
                            )
                        else:
                            logger.warning(f"[WS RECEIVER] Cancel request missing stream_id or controller unavailable")
                        continue  # Don't queue cancel requests

                    # Queue all other messages for processing
                    queue = self.message_queues.get(session_id)
                    print(f"RECEIVER [{session_id}]: Queue exists: {queue is not None}")
                    if queue:
                        await queue.put(data)
                        print(f"RECEIVER [{session_id}]: Message queued!")

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
            print(f"✓ Started receiver task for session {session_id}")
            logger.debug(f"Started receiver task for session {session_id}")

    async def receive_message(self, session_id: str, timeout: Optional[float] = None) -> Optional[WebSocketMessage]:
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

    async def handle_switch_session(self, session_id: str, new_session_id: str) -> Dict[str, Any]:
        """
        Handle session switching.

        Args:
            session_id: Current session ID
            new_session_id: Target session ID to switch to

        Returns:
            Session switched confirmation message
        """
        if not self.session_store:
            return {
                "type": "error",
                "code": "session_store_unavailable",
                "message": "Session store not initialized",
            }

        # Validate new session exists
        session_data = await self.session_store.get_session(new_session_id)
        if not session_data:
            return {
                "type": "error",
                "code": "session_not_found",
                "message": f"Session {new_session_id} not found",
            }

        # Close current session (if any)
        if session_id and session_id in self.active_connections:
            logger.info(f"Closing current session {session_id}")
            self.disconnect(session_id)

        # Load new session
        logger.info(f"Switching to session {new_session_id}")

        return {
            "type": "session_switched",
            "session_id": new_session_id,
            "session_data": session_data,
        }
