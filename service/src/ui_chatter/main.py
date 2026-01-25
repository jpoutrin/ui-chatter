"""Main FastAPI application with WebSocket support."""

import logging
import uuid
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from .config import settings
from .logging_config import setup_logging
from .models.messages import ChatRequest
from .screenshot_store import ScreenshotStore
from .session_manager import SessionManager
from .websocket import ConnectionManager

# Setup logging
setup_logging(level=settings.LOG_LEVEL, debug=settings.DEBUG)
logger = logging.getLogger(__name__)

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

    connection_manager = ConnectionManager(max_connections=settings.MAX_CONNECTIONS)
    session_manager = SessionManager(
        max_idle_minutes=settings.MAX_SESSION_IDLE_MINUTES,
        api_key=settings.ANTHROPIC_API_KEY,
    )
    screenshot_store = ScreenshotStore(project_path=settings.PROJECT_PATH)

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


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """Main WebSocket endpoint for browser extension."""
    session_id = str(uuid.uuid4())

    try:
        # Connect with origin validation
        await connection_manager.connect(session_id, websocket)

        # Create agent session using configured project path
        session = await session_manager.create_session(session_id, settings.PROJECT_PATH)

        logger.info(f"Session {session_id} ready for messages")

        # Main message loop
        while True:
            data = await websocket.receive_json()

            if data["type"] == "chat":
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

                # Stream response from agent
                async for response in session.agent_manager.handle_chat(
                    chat_request.context, chat_request.message, screenshot_path
                ):
                    await connection_manager.send_message(session_id, response)

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
