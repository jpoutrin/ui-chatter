"""Main FastAPI application with WebSocket support."""

import asyncio
import json
import logging
import os
import uuid
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException

from .config import settings
from .logging_config import setup_logging
from .models.messages import (
    ChatRequest,
    HandshakeMessage,
    UpdatePermissionModeMessage,
    PermissionModeUpdatedMessage,
)
from .screenshot_store import ScreenshotStore
from .session_manager import SessionManager
from .session_store import SessionStore
from .session_repository import SessionRepository
from .websocket import ConnectionManager

# Setup logging
setup_logging(level=settings.LOG_LEVEL, debug=settings.DEBUG)
logger = logging.getLogger(__name__)

# WebSocket receive timeout - allow long AI thinking periods
WS_RECEIVE_TIMEOUT = settings.WS_RECEIVE_TIMEOUT

# Global managers (initialized in lifespan)
connection_manager: ConnectionManager
session_manager: SessionManager
screenshot_store: ScreenshotStore


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan: startup and shutdown."""
    # Startup
    logger.info(f"Starting {settings.PROJECT_NAME}...")

    global connection_manager, session_manager, screenshot_store

    # Get project path from environment (set by CLI) or use settings default
    project_path = os.environ.get("UI_CHATTER_PROJECT_PATH", settings.PROJECT_PATH)
    logger.info(f"Project path: {project_path}")

    # Get permission mode from environment or use settings default
    permission_mode = os.environ.get("PERMISSION_MODE", settings.PERMISSION_MODE)

    connection_manager = ConnectionManager(
        max_connections=settings.MAX_CONNECTIONS,
        ping_interval=settings.WS_PING_INTERVAL,
        ping_timeout=settings.WS_PING_TIMEOUT
    )

    # Initialize session storage
    session_store = SessionStore(project_path=project_path)
    await session_store.initialize()

    # Initialize Claude Code session reader
    session_repository = SessionRepository(project_path=project_path)

    session_manager = SessionManager(
        max_idle_minutes=settings.MAX_SESSION_IDLE_MINUTES,
        project_path=project_path,
        permission_mode=permission_mode,
        session_store=session_store,
        session_repository=session_repository,
    )
    screenshot_store = ScreenshotStore(project_path=project_path)

    logger.info(f"Using Claude Agent SDK backend (subscription-based auth)")
    logger.info(f"Permission mode: {permission_mode}")

    # Recover sessions
    recovered = await session_manager.recover_sessions()
    if recovered > 0:
        logger.info(f"Recovered {recovered} active session(s)")

    # Start background tasks
    session_manager.start_cleanup_task()

    logger.info(f"{settings.PROJECT_NAME} started successfully")

    yield

    # Shutdown
    logger.info("Shutting down gracefully...")
    await session_manager.cleanup_all_sessions()
    logger.info("Shutdown complete")


# Create FastAPI app
app = FastAPI(
    title=settings.PROJECT_NAME,
    version="0.1.0",
    lifespan=lifespan,
)


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {
        "status": "ok",
        "service": settings.PROJECT_NAME,
        "active_sessions": session_manager.get_session_count(),
        "active_connections": connection_manager.get_connection_count(),
    }


@app.get("/sessions/{session_id}/messages")
async def get_session_messages(session_id: str):
    """
    Get conversation history for a session.

    Reads directly from Claude Code's local storage.
    """
    try:
        messages = await session_manager.get_conversation_history(session_id)

        return {
            "session_id": session_id,
            "message_count": len(messages),
            "messages": [
                {
                    "role": msg.role,
                    "content": msg.content,
                    "timestamp": msg.timestamp,
                    "uuid": msg.uuid
                }
                for msg in messages
            ]
        }
    except Exception as e:
        logger.error(f"Error retrieving messages: {e}")
        raise HTTPException(status_code=500, detail="Failed to retrieve messages")


@app.get("/sessions")
async def list_sessions():
    """List all sessions tracked by UI Chatter."""
    if not session_manager.session_store:
        return {"sessions": []}

    active_sessions = await session_manager.session_store.get_active_sessions()

    # Enrich with message counts from Claude Code storage
    enriched = []
    for session in active_sessions:
        if session_manager.session_repository:
            msg_count = session_manager.session_repository.get_message_count(
                session["session_id"]
            )
        else:
            msg_count = 0

        enriched.append({
            **session,
            "message_count": msg_count
        })

    return {"sessions": enriched}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """Main WebSocket endpoint for browser extension."""
    session_id = str(uuid.uuid4())

    try:
        # Connect with origin validation
        await connection_manager.connect(session_id, websocket)

        # Wait for handshake with permission mode
        handshake_data = await websocket.receive_json()

        # Debug logging for incoming message
        logger.debug(
            f"[WS IN] {session_id[:8]}... | handshake | {json.dumps(handshake_data)[:200]}"
        )

        permission_mode = "plan"  # Default
        if handshake_data.get("type") == "handshake":
            try:
                handshake = HandshakeMessage(**handshake_data)
                permission_mode = handshake.permission_mode
                logger.info(f"Received handshake with permission mode: {permission_mode}")
            except Exception as e:
                logger.warning(f"Invalid handshake, using default mode: {e}")

        # Create agent session with specified permission mode
        session = await session_manager.create_session(
            session_id,
            permission_mode=permission_mode
        )

        logger.info(f"Session {session_id} ready for messages")

        # Start background receiver task (processes pongs immediately)
        connection_manager.start_receiver(session_id, websocket, WS_RECEIVE_TIMEOUT)

        # Start ping keepalive task
        connection_manager.start_ping(session_id)

        # Main message loop - consume from queue
        while True:
            try:
                # Receive from queue (pongs are handled by receiver task)
                data = await asyncio.wait_for(
                    connection_manager.receive_message(session_id),
                    timeout=WS_RECEIVE_TIMEOUT
                )

                # Handle connection closed or error
                if data is None:
                    logger.info(f"[WS] {session_id[:8]}... | Connection closed by receiver")
                    break

            except asyncio.TimeoutError:
                logger.warning(
                    f"[WS] {session_id[:8]}... | No message in {WS_RECEIVE_TIMEOUT}s, "
                    "closing"
                )
                break

            # Debug logging for incoming messages
            msg_type = data.get("type", "unknown")
            logger.debug(f"[WS IN] {session_id[:8]}... | {msg_type} | {json.dumps(data)[:200]}")

            if data["type"] == "update_permission_mode":
                # Handle permission mode update
                try:
                    update_msg = UpdatePermissionModeMessage(**data)
                    await session_manager.update_permission_mode(
                        session_id, update_msg.mode
                    )

                    # Send acknowledgment
                    ack = PermissionModeUpdatedMessage(mode=update_msg.mode)
                    await connection_manager.send_message(
                        session_id, ack.model_dump()
                    )
                    logger.info(f"Permission mode updated to {update_msg.mode}")
                except Exception as e:
                    logger.error(f"Error updating permission mode: {e}")
                    await connection_manager.send_message(
                        session_id,
                        {
                            "type": "error",
                            "code": "permission_mode_update_failed",
                            "message": str(e),
                        },
                    )

            elif data["type"] == "chat":
                # Parse chat request
                try:
                    chat_request = ChatRequest(**data)
                except Exception as e:
                    logger.error(f"Invalid chat request: {e}")
                    await connection_manager.send_message(
                        session_id,
                        {
                            "type": "error",
                            "code": "invalid_request",
                            "message": "Invalid request format",
                        },
                    )
                    continue

                # Save screenshot if provided
                screenshot_path: Optional[str] = None
                if chat_request.screenshot:
                    try:
                        element_id = chat_request.context.element.id or "unknown"
                        screenshot_path = await screenshot_store.save(
                            session_id, element_id, chat_request.screenshot
                        )
                    except Exception as e:
                        logger.warning(f"Failed to save screenshot: {e}")

                # Send thinking status
                await connection_manager.send_message(
                    session_id,
                    {"type": "status", "status": "thinking", "detail": None},
                )

                # Check if this is the first message for this session
                is_first = session.is_first_message()

                # Stream response from agent backend
                async for response in session.backend.handle_chat(
                    chat_request.context,
                    chat_request.message,
                    is_first_message=is_first,
                    screenshot_path=screenshot_path,
                ):
                    await connection_manager.send_message(session_id, response)

                # Mark first message as sent in both session and store
                if is_first:
                    await session_manager.mark_first_message_sent(session_id)

                # Send done status
                await connection_manager.send_message(
                    session_id,
                    {"type": "status", "status": "done", "detail": None},
                )

    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected: {session_id}")

    except Exception as e:
        logger.error(f"WebSocket error: {e}", exc_info=True)
        try:
            await connection_manager.send_message(
                session_id,
                {"type": "error", "code": "internal", "message": str(e)},
            )
        except:
            pass

    finally:
        connection_manager.disconnect(session_id)
        await session_manager.remove_session(session_id)
