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
from .stream_controller import StreamController
from .project_files import ProjectFileLister
from .commands_discovery import CommandDiscovery, Command

# Setup logging
setup_logging(level=settings.LOG_LEVEL, debug=settings.DEBUG)
logger = logging.getLogger(__name__)

# WebSocket receive timeout - allow long AI thinking periods
WS_RECEIVE_TIMEOUT = settings.WS_RECEIVE_TIMEOUT

# Global managers (initialized in lifespan)
connection_manager: ConnectionManager
session_manager: SessionManager
screenshot_store: ScreenshotStore
stream_controller: StreamController


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan: startup and shutdown."""
    # Startup
    logger.info(f"Starting {settings.PROJECT_NAME}...")

    global connection_manager, session_manager, screenshot_store, stream_controller

    # Get project path from environment (set by CLI) or use settings default
    project_path = os.environ.get("UI_CHATTER_PROJECT_PATH", settings.PROJECT_PATH)
    logger.info(f"Project path: {project_path}")

    # Get permission mode from environment or use settings default
    permission_mode = os.environ.get("PERMISSION_MODE", settings.PERMISSION_MODE)

    # Initialize stream controller for cancellation support (BEFORE connection_manager)
    stream_controller = StreamController()

    connection_manager = ConnectionManager(
        max_connections=settings.MAX_CONNECTIONS,
        ping_interval=settings.WS_PING_INTERVAL,
        ping_timeout=settings.WS_PING_TIMEOUT,
        stream_controller=stream_controller
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
        msg_count = 0
        # Use SDK session ID to read from JSONL files (if available)
        sdk_session_id = session.get("sdk_session_id")
        if session_manager.session_repository and sdk_session_id:
            msg_count = session_manager.session_repository.get_message_count(
                sdk_session_id
            )

        enriched.append({
            **session,
            "message_count": msg_count
        })

    return {"sessions": enriched}


@app.get("/api/v1/agent-sessions")
async def list_agent_sessions():
    """List all Agent SDK sessions (Layer 2 sessions)."""
    if not session_manager.session_store:
        return {"agent_sessions": []}

    agent_sessions = await session_manager.session_store.get_all_sdk_sessions()

    return {
        "agent_sessions": agent_sessions,
        "count": len(agent_sessions)
    }


@app.post("/api/v1/sessions/{session_id}/switch-sdk-session")
async def switch_sdk_session(
    session_id: str,
    request_body: dict
):
    """
    Switch the current WebSocket session to use a different Agent SDK session.

    This allows resuming a previous conversation (Layer 2) in a new WebSocket connection (Layer 1).

    Request body: {"target_sdk_session_id": "sdk-uuid"}
    """
    target_sdk_session_id = request_body.get("target_sdk_session_id")
    if not target_sdk_session_id:
        raise HTTPException(
            status_code=400,
            detail="Missing required field: target_sdk_session_id"
        )

    # Validate session exists
    session = await session_manager.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # Switch to the target SDK session (recreates backend)
    try:
        await session_manager.switch_sdk_session(session_id, target_sdk_session_id)

        return {
            "session_id": session_id,
            "sdk_session_id": target_sdk_session_id,
            "status": "switched",
            "message": f"Session {session_id} now using Agent SDK session {target_sdk_session_id}"
        }
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error(f"Error switching SDK session: {e}")
        raise HTTPException(status_code=500, detail="Failed to switch SDK session")


@app.get("/api/v1/projects/{session_id}/files")
async def list_project_files(
    session_id: str,
    pattern: Optional[str] = None,
    prefix: Optional[str] = None,
    limit: int = 100
):
    """List files in project directory with optional filtering."""
    # 1. Validate session exists
    session = await session_manager.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # 2. Create file lister
    lister = ProjectFileLister(session.project_path)

    # 3. Get files
    try:
        result = await lister.list_files(pattern=pattern, prefix=prefix, limit=limit)
        return {
            "session_id": session_id,
            "project_path": session.project_path,
            **result
        }
    except Exception as e:
        logger.error(f"Error listing files: {e}")
        raise HTTPException(status_code=500, detail="Failed to list files")


@app.get("/api/v1/projects/{session_id}/commands")
async def list_commands(
    session_id: str,
    prefix: Optional[str] = None,
    limit: int = 50,
    mode: str = "agent"  # "agent", "shell", "all"
):
    """List available commands (agent slash commands or shell commands)."""
    # 1. Validate session exists
    session = await session_manager.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # 2. Validate mode parameter
    if mode not in ["agent", "shell", "all"]:
        raise HTTPException(status_code=400, detail="Invalid mode. Use 'agent', 'shell', or 'all'")

    # 3. Discover commands
    discovery = CommandDiscovery(
        project_path=session.project_path,
        backend=session.backend
    )

    # 4. Get commands
    try:
        commands = await discovery.discover_commands(mode=mode)

        # Filter by prefix if provided (fuzzy matching)
        if prefix:
            # For agent commands, strip leading slash for comparison
            prefix_normalized = prefix.lstrip('/') if prefix.startswith('/') else prefix
            prefix_lower = prefix_normalized.lower()

            # Score and filter commands based on fuzzy matching
            scored_commands = []
            for cmd in commands:
                name_lower = cmd.name.lower()
                command_lower = cmd.command.lower()

                # Calculate match score
                score = 0
                if name_lower.startswith(prefix_lower):
                    # Prefix match gets highest score
                    score = 100
                elif prefix_lower in name_lower:
                    # Contains match gets medium score
                    # Bonus for earlier position
                    position = name_lower.index(prefix_lower)
                    score = 50 - position
                elif command_lower.startswith(prefix):
                    # Command prefix match
                    score = 90
                elif prefix_lower in command_lower:
                    # Command contains match
                    position = command_lower.index(prefix_lower)
                    score = 40 - position

                if score > 0:
                    scored_commands.append((score, cmd))

            # Sort by score (highest first) and extract commands
            scored_commands.sort(key=lambda x: x[0], reverse=True)
            commands = [cmd for score, cmd in scored_commands]

        # Apply limit
        commands = commands[:limit]

        return {
            "session_id": session_id,
            "mode": mode,
            "command_count": len(commands),
            "commands": [cmd.model_dump() for cmd in commands]
        }
    except Exception as e:
        logger.error(f"Error discovering commands: {e}")
        raise HTTPException(status_code=500, detail="Failed to discover commands")


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
        page_url = None
        tab_id = None

        if handshake_data.get("type") == "handshake":
            try:
                handshake = HandshakeMessage(**handshake_data)
                permission_mode = handshake.permission_mode
                page_url = handshake.page_url
                tab_id = handshake.tab_id
                logger.info(
                    f"Received handshake with permission mode: {permission_mode}, "
                    f"page_url: {page_url}, tab_id: {tab_id}"
                )
            except Exception as e:
                logger.warning(f"Invalid handshake, using default mode: {e}")

        # Create agent session with specified permission mode and auto-resume support
        session = await session_manager.create_session(
            session_id,
            permission_mode=permission_mode,
            page_url=page_url,
            tab_id=tab_id,
            auto_resume=True,
        )

        # Send handshake acknowledgment with resumed flag and SDK session ID
        resumed = session.backend.has_established_session
        sdk_session_id = session.backend.sdk_session_id if resumed else None

        await connection_manager.send_message(
            session_id,
            {
                "type": "handshake_ack",
                "session_id": session_id,
                "permission_mode": permission_mode,
                "resumed": resumed,
                "sdk_session_id": sdk_session_id,
            },
        )

        logger.info(f"Session {session_id} ready for messages (resumed: {resumed})")

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

            if data["type"] == "cancel_request":
                # This should never be reached - cancel_request is handled immediately in receiver loop
                logger.warning(f"[WS MAIN] Cancel request reached main loop (should be handled in receiver)")

                # Keep as defensive fallback
                stream_id = data.get("stream_id")
                if stream_id:
                    success = stream_controller.cancel_stream(stream_id)
                    await connection_manager.send_message(
                        session_id,
                        {
                            "type": "status",
                            "status": "cancelled" if success else "error",
                            "detail": "Stream cancelled" if success else "Stream not found"
                        }
                    )
                    logger.info(f"Cancel request for stream {stream_id}: {'success' if success else 'failed'}")
                else:
                    logger.warning("Cancel request without stream_id")

            elif data["type"] == "update_permission_mode":
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

                # Create stream with cancellation support BEFORE starting the stream
                # Generate stream_id upfront so cancel_event can be created immediately
                current_stream_id = f"stream-{uuid.uuid4()}"
                cancel_event = stream_controller.create_stream(current_stream_id)
                logger.info(f"Stream {current_stream_id} created with cancellation support (before backend call)")

                # Send thinking status
                await connection_manager.send_message(
                    session_id,
                    {"type": "status", "status": "thinking", "detail": None},
                )

                # Send stream started control message
                await connection_manager.send_message(
                    session_id,
                    {
                        "type": "stream_control",
                        "action": "started",
                        "stream_id": current_stream_id
                    }
                )

                # Stream response from agent backend with cancellation support
                async for response in session.backend.handle_chat(
                    context=chat_request.context,
                    message=chat_request.message,
                    screenshot_path=screenshot_path,
                    cancel_event=cancel_event,
                ):
                    chunk_type = response.get("type")

                    if chunk_type == "session_established":
                        # Backend established SDK session, persist it
                        sdk_session_id = response.get("sdk_session_id")
                        if sdk_session_id:
                            await session_manager.update_sdk_session_id(session_id, sdk_session_id)

                            # Generate session title from first message (first 50 chars)
                            title = chat_request.message[:50].strip()
                            if len(chat_request.message) > 50:
                                title += "..."

                            # Set the session title
                            if session_manager.session_store:
                                await session_manager.session_store.set_session_title(session_id, title)
                                logger.info(f"Set session title: {title}")
                        # Don't forward to client
                        continue

                    # Handle stream_control messages from backend
                    if chunk_type == "stream_control":
                        action = response.get("action")
                        if action == "cancelled":
                            # Backend detected cancellation - forward to client with our stream_id
                            await connection_manager.send_message(
                                session_id,
                                {
                                    "type": "stream_control",
                                    "action": "cancelled",
                                    "stream_id": current_stream_id,
                                    "reason": response.get("reason", "user_request")
                                }
                            )
                            logger.info(f"Stream {current_stream_id} cancelled by user")
                            # Cleanup and exit loop
                            stream_controller.cleanup_stream(current_stream_id)
                            break
                        else:
                            # Skip other stream_control messages (started, completed) - we handle these
                            logger.debug(f"Skipping backend stream_control message: {action}")
                            continue

                    await connection_manager.send_message(session_id, response)
                else:
                    # Loop completed normally (not cancelled)
                    # Send completion message
                    await connection_manager.send_message(
                        session_id,
                        {
                            "type": "stream_control",
                            "action": "completed",
                            "stream_id": current_stream_id
                        }
                    )
                    logger.info(f"Stream {current_stream_id} completed successfully")

                    # Cleanup stream
                    stream_controller.cleanup_stream(current_stream_id)

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
