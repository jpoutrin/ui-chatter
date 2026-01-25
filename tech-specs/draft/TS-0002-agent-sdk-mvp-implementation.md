# TS-0002: Agent SDK MVP Implementation

## Metadata

| Field | Value |
|-------|-------|
| **Tech Spec ID** | TS-0002 |
| **Title** | Agent SDK MVP Implementation |
| **Status** | DRAFT |
| **Author** | |
| **Created** | 2026-01-25 |
| **Last Updated** | 2026-01-25 |
| **Decision Ref** | [ADR-0001: Use Agent SDK Over ACP](../../docs/decisions/ADR-0001-use-agent-sdk-over-acp.md) |
| **Related Docs** | [POC Results](../../poc/POC-RESULTS.md), [TS-0001: ACP POC](./TS-0001-acp-browser-integration-poc.md), [UI Context Bridge Brainstorm](../../docs/tech-brainstorm/2026-01-08-ui-context-bridge/session-summary.md) |

---

## Executive Summary

### Problem Statement

Following the ACP POC (TS-0001), we've validated the browser-to-agent architecture but identified that subprocess spawn latency (~60s) makes ACP non-viable for real-time chat. We need to implement the production-ready system using Claude Agent SDK for acceptable latency (<1s).

### Proposed Solution

Build a Python FastAPI service with Claude Agent SDK that:
- Reuses the validated Chrome extension from POC
- Maintains the WebSocket protocol (proven to work)
- Provides in-process agent execution for <1s latency
- Supports project-local storage and settings inheritance
- Enables screenshot capture and hot-reload workflows

### Success Criteria

| Metric | Target | Rationale |
|--------|--------|-----------|
| First token latency | < 1 second | Real-time chat UX (100x better than ACP) |
| Chrome extension reuse | 100% code reuse | Validated in POC, no rework needed |
| Memory footprint | < 500MB | Reasonable for long-running Python service |
| Settings inheritance | Full `.claude/settings.json` support | Security and permission consistency |
| Multi-tab support | Isolated sessions | Professional dev tool requirement |

---

## Design Overview

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Agent SDK MVP Architecture                            │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────┐              ┌─────────────────────────────────────────────┐
│ Chrome Extension│              │         Python FastAPI Service              │
│  (from POC)     │              │                                             │
│                 │              │  ┌─────────────────────────────────────┐   │
│  ┌───────────┐  │   WebSocket  │  │  FastAPI + WebSocket Server         │   │
│  │ Content   │  │──────────────│─▶│                                     │   │
│  │ Script    │  │              │  │  • Receives context + message       │   │
│  │           │  │              │  │  • Manages Claude Agent instances  │   │
│  │ • Click   │  │              │  │  • Streams responses               │   │
│  │   mode    │  │              │  │  • Screenshot storage              │   │
│  │ • DOM     │  │◀─────────────│──│                                     │   │
│  │   extract │  │   Streaming  │  └──────────────┬──────────────────────┘   │
│  └───────────┘  │   Response   │                 │                           │
│                 │              │                 │ In-process                │
│  ┌───────────┐  │              │                 ▼                           │
│  │ Side      │  │              │  ┌─────────────────────────────────────┐   │
│  │ Panel     │  │              │  │  Claude Agent SDK                   │   │
│  │           │  │              │  │                                     │   │
│  │ • Chat UI │  │              │  │  • In-memory agent                 │   │
│  │ • Status  │  │              │  │  • Full tool access                │   │
│  └───────────┘  │              │  │  • Project settings inheritance    │   │
└─────────────────┘              │  └─────────────────────────────────────┘   │
                                 │                                             │
                                 │  ┌─────────────────────────────────────┐   │
                                 │  │  Project Storage                    │   │
                                 │  │                                     │   │
                                 │  │  .ui-chatter/                       │   │
                                 │  │  ├── sessions/                      │   │
                                 │  │  ├── screenshots/                   │   │
                                 │  │  └── history.db                     │   │
                                 │  └─────────────────────────────────────┘   │
                                 └─────────────────────────────────────────────┘
```

### Data Flow

Same as POC, but with Agent SDK:

```
1. User clicks element in browser
   ↓
2. Content script captures DOM + bounding box
   ↓
3. User types message: "make this blue"
   ↓
4. Extension sends via WebSocket:
   {
     type: "chat",
     element: {...},
     screenshot: "base64...",
     message: "make this blue"
   }
   ↓
5. FastAPI receives, builds prompt
   ↓
6. Agent SDK processes (IN-PROCESS):
   • Interprets context
   • Searches codebase
   • Generates response
   ↓
7. Response streams back:
   Agent SDK → FastAPI → WebSocket → Extension
   ↓
8. Side panel displays response in real-time
```

---

## Component Specifications

### 1. Chrome Extension (Reuse from POC)

**Status**: ✅ Already complete, no changes needed

The extension from POC will work as-is because:
- WebSocket protocol remains identical
- Message format unchanged
- DOM extraction logic validated

**Minor Enhancements** (optional, post-MVP):
- Screenshot cropping (not needed for latency test)
- Multiple element selection
- Session persistence UI

### 2. Python FastAPI Service

#### Dependencies

Using UV for fast, reliable package management:

```toml
[project]
name = "ui-chatter"
version = "0.1.0"
description = "UI Chatter - Browser to Claude Code integration"
requires-python = ">=3.10"
dependencies = [
    "fastapi>=0.115.0",
    "uvicorn[standard]>=0.32.0",
    "pydantic>=2.10.0",
    "pydantic-settings>=2.7.0",
    "typer>=0.15.0",
    "pillow>=10.4.0",
    "aiofiles>=24.1.0",
    "python-multipart>=0.0.20",
    "claude-agent-sdk>=0.2.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.3.0",
    "pytest-asyncio>=0.24.0",
    "pytest-cov>=6.0.0",
    "httpx>=0.28.0",
    "black>=24.10.0",
    "ruff>=0.8.0",
    "mypy>=1.13.0",
]

[project.scripts]
ui-chatter = "ui_chatter.cli:app"

[tool.uv]
dev-dependencies = [
    "pytest>=8.3.0",
    "pytest-asyncio>=0.24.0",
    "pytest-cov>=6.0.0",
    "httpx>=0.28.0",
]
```

**Setup with UV:**

```bash
# Install UV
curl -LsSf https://astral.sh/uv/install.sh | sh

# Create virtual environment and install dependencies
uv venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate
uv pip install -e .

# Install dev dependencies
uv pip install -e ".[dev]"
```

#### Project Structure

```
service/
├── pyproject.toml
├── uv.lock
├── .env.example
├── .python-version         # Pin Python version for UV
├── README.md
├── src/
│   └── ui_chatter/
│       ├── __init__.py
│       ├── main.py              # FastAPI app + lifespan management
│       ├── websocket.py         # WebSocket connection manager
│       ├── agent_manager.py     # Agent SDK lifecycle
│       ├── session_manager.py   # Multi-session with cleanup
│       ├── prompt_builder.py    # Build prompts from UI context
│       ├── screenshot_store.py  # Async screenshot storage
│       ├── config.py             # Pydantic settings
│       ├── exceptions.py        # Custom exceptions
│       ├── dependencies.py      # FastAPI dependencies
│       ├── middleware.py        # CORS, error handling
│       ├── logging_config.py    # Logging setup
│       ├── cli.py               # Typer CLI interface
│       ├── schemas/
│       │   ├── __init__.py
│       │   ├── websocket.py     # Request/response schemas
│       │   └── config.py        # Config schemas
│       └── models/
│           ├── __init__.py
│           ├── messages.py      # WebSocket message types
│           ├── context.py       # UI context models
│           └── session.py       # Session state models
└── tests/
    ├── __init__.py
    ├── conftest.py              # Pytest fixtures
    ├── unit/
    │   ├── __init__.py
    │   ├── test_agent_manager.py
    │   ├── test_screenshot_store.py
    │   ├── test_session_manager.py
    │   └── test_prompt_builder.py
    └── integration/
        ├── __init__.py
        └── test_websocket.py
```

#### WebSocket Message Types

Reuse from POC (validated protocol):

```python
# Extension → Server
class ChatRequest(BaseModel):
    type: Literal["chat"]
    context: CapturedContext
    screenshot: Optional[str]  # base64 PNG
    message: str

# Server → Extension
class ResponseChunk(BaseModel):
    type: Literal["response_chunk"]
    content: str
    done: bool

class StatusUpdate(BaseModel):
    type: Literal["status"]
    status: Literal["idle", "thinking", "done", "error"]
    detail: Optional[str]
```

#### Agent SDK Integration

**Proper lifecycle management with error handling:**

```python
from claude_agent_sdk import ClaudeAgent, ClaudeAgentOptions
from claude_agent_sdk.exceptions import (
    AgentAuthError,
    AgentRateLimitError,
    AgentTimeoutError
)
from typing import AsyncGenerator, Optional
import asyncio
import logging

logger = logging.getLogger(__name__)

class AgentManager:
    """
    Manages Claude Agent SDK lifecycle with proper resource management.

    Features:
    - Lazy initialization with async locking
    - Proper error handling and recovery
    - Graceful shutdown
    """

    def __init__(self, project_path: str):
        self.project_path = project_path
        self._agent: Optional[ClaudeAgent] = None
        self._lock = asyncio.Lock()

    async def get_agent(self) -> ClaudeAgent:
        """Get or create agent instance (thread-safe lazy init)."""
        async with self._lock:
            if self._agent is None:
                self._agent = await self._create_agent()
            return self._agent

    async def _create_agent(self) -> ClaudeAgent:
        """Create agent asynchronously."""
        logger.info(f"Initializing Claude Agent for project: {self.project_path}")

        options = ClaudeAgentOptions(
            cwd=self.project_path,
            setting_sources=["project"],  # Load .claude/settings.json
        )

        agent = await ClaudeAgent.create(options)
        logger.info("Claude Agent initialized successfully")
        return agent

    async def handle_chat(
        self,
        context: CapturedContext,
        message: str,
        screenshot_path: Optional[str] = None
    ) -> AsyncGenerator[dict, None]:
        """
        Stream response from Agent SDK with error handling.

        Yields:
            dict: Response chunks or error messages

        Latency: ~0.5s first token (vs 60s with ACP) ⚡
        """
        try:
            agent = await self.get_agent()
            prompt = build_prompt(context, message, screenshot_path)

            logger.debug(f"Sending prompt to agent (length: {len(prompt)} chars)")

            async for chunk in agent.chat(prompt):
                yield {"type": "response_chunk", "content": chunk, "done": False}

            # Final chunk
            yield {"type": "response_chunk", "content": "", "done": True}

        except AgentAuthError as e:
            logger.error(f"Authentication failed: {e}")
            yield {
                "type": "error",
                "code": "auth_failed",
                "message": "Authentication failed. Please check your Claude credentials."
            }

        except AgentRateLimitError as e:
            logger.warning(f"Rate limit hit: {e}")
            yield {
                "type": "error",
                "code": "rate_limit",
                "message": "Rate limit exceeded. Please try again in a few moments."
            }

        except AgentTimeoutError as e:
            logger.error(f"Request timeout: {e}")
            yield {
                "type": "error",
                "code": "timeout",
                "message": "Request timed out. Please try again."
            }

        except Exception as e:
            logger.error(f"Unexpected agent error: {e}", exc_info=True)
            yield {
                "type": "error",
                "code": "internal",
                "message": "An unexpected error occurred. Please try again."
            }

    async def shutdown(self):
        """Cleanup on service shutdown."""
        if self._agent:
            logger.info("Shutting down Claude Agent...")
            await self._agent.close()
            self._agent = None
            logger.info("Claude Agent shut down successfully")
```

#### WebSocket Connection Manager

**Connection lifecycle with origin validation:**

```python
from fastapi import WebSocket, WebSocketDisconnect, status
from typing import Dict
import logging

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

    async def connect(self, session_id: str, websocket: WebSocket):
        """Accept WebSocket connection with validation."""
        # Validate origin (CRITICAL for security)
        origin = websocket.headers.get("origin", "")
        if not origin.startswith("chrome-extension://"):
            logger.warning(f"Rejected connection from invalid origin: {origin}")
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            raise ValueError(f"Invalid origin: {origin}")

        # Check connection limit
        if len(self.active_connections) >= self.max_connections:
            logger.warning("Connection limit reached")
            await websocket.close(code=1008, reason="Server at capacity")
            raise RuntimeError("Server at capacity")

        await websocket.accept()
        self.active_connections[session_id] = websocket
        logger.info(f"WebSocket connected: {session_id} (total: {len(self.active_connections)})")

    def disconnect(self, session_id: str):
        """Remove connection."""
        self.active_connections.pop(session_id, None)
        logger.info(f"WebSocket disconnected: {session_id}")

    async def send_message(self, session_id: str, message: dict):
        """Send JSON message to specific session."""
        websocket = self.active_connections.get(session_id)
        if websocket:
            await websocket.send_json(message)
        else:
            logger.warning(f"Attempted to send to non-existent session: {session_id}")
```

#### Session Manager

**Multi-session support with automatic cleanup:**

```python
from typing import Dict, Optional
from datetime import datetime, timedelta
import asyncio
import logging

logger = logging.getLogger(__name__)

class AgentSession:
    """Represents a single agent session with state."""

    def __init__(self, session_id: str, project_path: str):
        self.session_id = session_id
        self.project_path = project_path
        self.created_at = datetime.now()
        self.last_activity = datetime.now()
        self.agent_manager = AgentManager(project_path)

    def touch(self):
        """Update last activity timestamp."""
        self.last_activity = datetime.now()

class SessionManager:
    """
    Manages multiple agent sessions with automatic cleanup.

    Features:
    - Session isolation
    - Automatic idle session cleanup
    - Resource management
    """

    def __init__(self, max_idle_minutes: int = 30):
        self.max_idle_minutes = max_idle_minutes
        self.sessions: Dict[str, AgentSession] = {}
        self._cleanup_task: Optional[asyncio.Task] = None

    async def create_session(
        self,
        session_id: str,
        project_path: str
    ) -> AgentSession:
        """Create new isolated agent session."""
        session = AgentSession(session_id, project_path)
        self.sessions[session_id] = session
        logger.info(f"Created session: {session_id}")
        return session

    async def get_session(self, session_id: str) -> Optional[AgentSession]:
        """Get existing session and update activity."""
        session = self.sessions.get(session_id)
        if session:
            session.touch()
        return session

    async def remove_session(self, session_id: str):
        """Remove and cleanup session."""
        session = self.sessions.pop(session_id, None)
        if session:
            await session.agent_manager.shutdown()
            logger.info(f"Removed session: {session_id}")

    def start_cleanup_task(self):
        """Start background cleanup task."""
        if self._cleanup_task is None:
            self._cleanup_task = asyncio.create_task(self._cleanup_loop())
            logger.info("Session cleanup task started")

    async def _cleanup_loop(self):
        """Background task to cleanup idle sessions."""
        while True:
            try:
                await asyncio.sleep(60)  # Check every minute
                await self._cleanup_idle_sessions()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in cleanup loop: {e}", exc_info=True)

    async def _cleanup_idle_sessions(self):
        """Remove sessions idle for too long."""
        cutoff = datetime.now() - timedelta(minutes=self.max_idle_minutes)
        to_remove = [
            sid for sid, session in self.sessions.items()
            if session.last_activity < cutoff
        ]

        for sid in to_remove:
            logger.info(f"Removing idle session: {sid}")
            await self.remove_session(sid)

    async def cleanup_all_sessions(self):
        """Cleanup all sessions (shutdown)."""
        logger.info("Cleaning up all sessions...")
        for sid in list(self.sessions.keys()):
            await self.remove_session(sid)

        if self._cleanup_task:
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass

#### Screenshot Storage

**Async I/O to avoid blocking:**

```python
from pathlib import Path
import base64
from datetime import datetime, timedelta
import aiofiles
import asyncio
import logging

logger = logging.getLogger(__name__)

class ScreenshotStore:
    """
    Async screenshot storage with automatic cleanup.

    Features:
    - Non-blocking base64 decode
    - Async file writes
    - Automatic old file cleanup
    """

    def __init__(self, project_path: str):
        self.screenshots_dir = Path(project_path) / ".ui-chatter" / "screenshots"
        self.screenshots_dir.mkdir(parents=True, exist_ok=True)

    async def save(
        self,
        session_id: str,
        context_id: str,
        base64_data: str
    ) -> str:
        """Save screenshot asynchronously and return file path."""
        filename = f"{session_id}_{context_id}.png"
        filepath = self.screenshots_dir / filename

        try:
            # Decode in thread pool to avoid blocking event loop
            loop = asyncio.get_event_loop()
            image_data = await loop.run_in_executor(
                None,
                base64.b64decode,
                base64_data.split(",")[1]
            )

            # Async file write
            async with aiofiles.open(filepath, "wb") as f:
                await f.write(image_data)

            logger.debug(f"Saved screenshot: {filename} ({len(image_data)} bytes)")
            return str(filepath)

        except Exception as e:
            logger.error(f"Failed to save screenshot: {e}", exc_info=True)
            raise

    async def cleanup_old(self, max_age_hours: int = 24):
        """Delete screenshots older than max_age_hours."""
        cutoff = datetime.now() - timedelta(hours=max_age_hours)
        removed_count = 0

        for screenshot in self.screenshots_dir.glob("*.png"):
            if datetime.fromtimestamp(screenshot.stat().st_mtime) < cutoff:
                try:
                    screenshot.unlink()
                    removed_count += 1
                except Exception as e:
                    logger.warning(f"Failed to delete {screenshot}: {e}")

        if removed_count > 0:
            logger.info(f"Cleaned up {removed_count} old screenshot(s)")
```

#### Configuration Management

**Environment-based configuration with pydantic-settings:**

```python
from pydantic_settings import BaseSettings, SettingsConfigDict
from pathlib import Path
from typing import Optional

class Settings(BaseSettings):
    """
    Application settings with environment variable support.

    Priority: ENV > .env file > defaults
    """
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=True
    )

    # Service configuration
    PROJECT_NAME: str = "UI Chatter"
    DEBUG: bool = False
    HOST: str = "localhost"
    PORT: int = 3456
    LOG_LEVEL: str = "INFO"

    # Agent SDK configuration
    CLAUDE_API_KEY: Optional[str] = None  # Fallback if OAuth unavailable

    # Storage
    MAX_SCREENSHOT_AGE_HOURS: int = 24
    MAX_SESSION_IDLE_MINUTES: int = 30

    # Security
    ALLOWED_ORIGINS: list[str] = ["chrome-extension://"]
    MAX_CONNECTIONS: int = 100

    # Performance
    WORKER_COUNT: int = 1  # Uvicorn workers

# Global settings instance
settings = Settings()
```

### 3. CLI Interface

**Typer CLI with signal handling and health checks:**

```bash
# Start server
ui-chatter serve [OPTIONS]

Options:
  --project PATH    Project directory (default: current)
  --port INTEGER    WebSocket port (default: 3456)
  --host TEXT       Bind address (default: localhost)
  --debug           Enable debug logging
  --reload          Enable auto-reload (dev mode)
  --help            Show help message
```

**Implementation:**

```python
import typer
import uvicorn
import httpx
import signal
import sys
from pathlib import Path
from typing import Optional
from rich.console import Console
from rich.panel import Panel

app = typer.Typer(
    name="ui-chatter",
    help="UI Chatter - Browser to Claude Code integration",
    add_completion=False
)
console = Console()

async def check_service_running(port: int) -> bool:
    """Check if service is already running."""
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"http://localhost:{port}/health",
                timeout=2.0
            )
            return resp.status_code == 200
    except:
        return False

@app.command()
def serve(
    project: str = typer.Option(
        ".",
        "--project",
        "-p",
        help="Project directory"
    ),
    port: int = typer.Option(
        3456,
        "--port",
        help="WebSocket port"
    ),
    host: str = typer.Option(
        "localhost",
        "--host",
        help="Bind address"
    ),
    debug: bool = typer.Option(
        False,
        "--debug",
        help="Enable debug logging"
    ),
    reload: bool = typer.Option(
        False,
        "--reload",
        help="Enable auto-reload (dev mode)"
    )
):
    """Start UI Chatter service."""
    project_path = Path(project).resolve()

    # Validate project directory
    if not project_path.exists():
        console.print(f"[red]Error:[/red] Project directory not found: {project_path}")
        raise typer.Exit(1)

    # Check if already running
    import asyncio
    if asyncio.run(check_service_running(port)):
        console.print(f"[red]Error:[/red] Service already running on port {port}")
        raise typer.Exit(1)

    # Auto-add .ui-chatter/ to .gitignore
    gitignore = project_path / ".gitignore"
    if gitignore.exists():
        content = gitignore.read_text()
        if ".ui-chatter/" not in content:
            with gitignore.open("a") as f:
                f.write("\n# UI Chatter\n.ui-chatter/\n")
            console.print("[green]✓[/green] Added .ui-chatter/ to .gitignore")

    # Setup signal handlers for graceful shutdown
    def signal_handler(sig, frame):
        console.print("\n[yellow]Shutting down gracefully...[/yellow]")
        sys.exit(0)

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    # Display startup info
    console.print(Panel.fit(
        f"[bold]UI Chatter Service[/bold]\n\n"
        f"📁 Project: {project_path}\n"
        f"📡 WebSocket: ws://{host}:{port}\n"
        f"🔍 Debug: {'enabled' if debug else 'disabled'}",
        border_style="green"
    ))

    # Start Uvicorn
    uvicorn.run(
        "ui_chatter.main:app",
        host=host,
        port=port,
        log_level="debug" if debug else "info",
        reload=reload,
        access_log=debug
    )

if __name__ == "__main__":
    app()
```

### 4. FastAPI Application

**Main application with lifespan management:**

```python
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from contextlib import asynccontextmanager
import logging
import uuid

from ui_chatter.config import settings
from ui_chatter.websocket import ConnectionManager
from ui_chatter.session_manager import SessionManager
from ui_chatter.screenshot_store import ScreenshotStore
from ui_chatter.logging_config import setup_logging

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
    session_manager = SessionManager(max_idle_minutes=settings.MAX_SESSION_IDLE_MINUTES)
    screenshot_store = ScreenshotStore(project_path=".")  # Updated per request

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
    lifespan=lifespan
)

@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {
        "status": "ok",
        "service": settings.PROJECT_NAME,
        "active_sessions": len(session_manager.sessions)
    }

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """Main WebSocket endpoint for browser extension."""
    session_id = str(uuid.uuid4())

    try:
        # Connect with origin validation
        await connection_manager.connect(session_id, websocket)

        # Create agent session
        # TODO: Get project_path from handshake message
        project_path = "."
        session = await session_manager.create_session(session_id, project_path)

        # Main message loop
        while True:
            data = await websocket.receive_json()

            if data["type"] == "chat":
                # Handle chat request
                context = data["context"]
                message = data["message"]
                screenshot_b64 = data.get("screenshot")

                # Save screenshot if provided
                screenshot_path = None
                if screenshot_b64:
                    screenshot_path = await screenshot_store.save(
                        session_id,
                        context.get("element", {}).get("id", "unknown"),
                        screenshot_b64
                    )

                # Stream response from agent
                async for response in session.agent_manager.handle_chat(
                    context,
                    message,
                    screenshot_path
                ):
                    await connection_manager.send_message(session_id, response)

    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected: {session_id}")

    except Exception as e:
        logger.error(f"WebSocket error: {e}", exc_info=True)
        await connection_manager.send_message(
            session_id,
            {"type": "error", "code": "internal", "message": str(e)}
        )

    finally:
        connection_manager.disconnect(session_id)
        await session_manager.remove_session(session_id)
```

---

## API Specifications

### WebSocket Endpoint

Same as POC (validated protocol):

| Aspect | Value |
|--------|-------|
| URL | `ws://localhost:3456/ws` |
| Protocol | WebSocket (RFC 6455) |
| Message format | JSON |
| Reconnection | Client handles with exponential backoff |

### Message Schemas

Reuse from POC - already validated in end-to-end testing.

---

## Security Considerations

| Concern | Implementation | Status |
|---------|----------------|--------|
| **WebSocket origin** | Validate `chrome-extension://` origin | Required |
| **File access** | Scoped to project via Agent SDK options | Required |
| **Settings inheritance** | Use Agent SDK's built-in settings loader | Required |
| **Screenshot cleanup** | Auto-delete > 24 hours | Required |
| **Tool permissions** | Inherit from `.claude/settings.json` | Required |

---

## Testing Plan

### Pytest Configuration

```toml
# pyproject.toml
[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
python_files = "test_*.py"
python_functions = "test_*"
addopts = [
    "-v",
    "--cov=src/ui_chatter",
    "--cov-report=html",
    "--cov-report=term-missing:skip-covered",
    "--strict-markers",
]
markers = [
    "unit: Unit tests",
    "integration: Integration tests",
    "slow: Slow tests",
]

[tool.coverage.run]
source = ["src/ui_chatter"]
omit = ["*/tests/*", "*/test_*.py"]

[tool.coverage.report]
exclude_lines = [
    "pragma: no cover",
    "def __repr__",
    "raise AssertionError",
    "raise NotImplementedError",
    "if __name__ == .__main__.:",
    "if TYPE_CHECKING:",
]
```

### Test Fixtures

```python
# tests/conftest.py
import pytest
import pytest_asyncio
from fastapi.testclient import TestClient
from pathlib import Path
import tempfile
from unittest.mock import AsyncMock, MagicMock

@pytest.fixture
def temp_project_dir():
    """Create temporary project directory with .claude/settings.json."""
    with tempfile.TemporaryDirectory() as tmpdir:
        project_path = Path(tmpdir)

        # Create .claude directory structure
        claude_dir = project_path / ".claude"
        claude_dir.mkdir()
        (claude_dir / "settings.json").write_text('{"allowedTools": []}')

        # Create .ui-chatter directory
        ui_chatter_dir = project_path / ".ui-chatter"
        ui_chatter_dir.mkdir()

        yield project_path

@pytest.fixture
def mock_agent():
    """Mock Claude Agent SDK."""
    agent = AsyncMock()

    # Mock chat method to yield chunks
    async def mock_chat(prompt):
        yield {"type": "response_chunk", "content": "Test ", "done": False}
        yield {"type": "response_chunk", "content": "response", "done": False}
        yield {"type": "response_chunk", "content": "", "done": True}

    agent.chat = mock_chat
    agent.close = AsyncMock()

    return agent

@pytest_asyncio.fixture
async def test_client(temp_project_dir, monkeypatch):
    """FastAPI test client with mocked dependencies."""
    from ui_chatter.main import app

    # Mock Agent SDK initialization
    monkeypatch.setattr(
        "ui_chatter.agent_manager.ClaudeAgent.create",
        AsyncMock(return_value=mock_agent())
    )

    return TestClient(app)

@pytest_asyncio.fixture
async def websocket_client(test_client):
    """WebSocket test client."""
    with test_client.websocket_connect("/ws") as ws:
        yield ws
```

### Unit Tests

```python
# tests/unit/test_prompt_builder.py
import pytest
from ui_chatter.prompt_builder import build_prompt
from ui_chatter.models.context import CapturedContext, CapturedElement

@pytest.mark.unit
def test_builds_prompt_from_context():
    """Test prompt building includes all context."""
    element = CapturedElement(
        tagName="button",
        id="submit-btn",
        classList=["btn", "primary"],
        textContent="Submit"
    )
    context = CapturedContext(element=element, page={"url": "http://localhost"})

    prompt = build_prompt(context, "make this blue")

    assert "make this blue" in prompt
    assert "<button>" in prompt
    assert "submit-btn" in prompt

# tests/unit/test_screenshot_store.py
import pytest
from ui_chatter.screenshot_store import ScreenshotStore

@pytest.mark.unit
@pytest.mark.asyncio
async def test_saves_screenshot(temp_project_dir):
    """Test async screenshot saving."""
    store = ScreenshotStore(str(temp_project_dir))

    # Valid base64 PNG (1x1 transparent pixel)
    base64_png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

    path = await store.save("session1", "ctx1", base64_png)

    assert Path(path).exists()
    assert Path(path).suffix == ".png"
```

### Integration Tests

```python
# tests/integration/test_websocket.py
import pytest
import json
from unittest.mock import AsyncMock

@pytest.mark.integration
@pytest.mark.asyncio
async def test_websocket_chat_flow(websocket_client, mock_agent):
    """Test end-to-end WebSocket chat."""
    # Send chat request
    request = {
        "type": "chat",
        "context": {
            "element": {"tagName": "button", "id": "test"},
            "page": {"url": "http://localhost"}
        },
        "message": "describe this element"
    }

    await websocket_client.send_json(request)

    # Receive response chunks
    chunks = []
    while True:
        data = await websocket_client.receive_json()
        if data["type"] == "response_chunk":
            chunks.append(data["content"])
            if data["done"]:
                break

    response = "".join(chunks)
    assert len(response) > 0

@pytest.mark.integration
@pytest.mark.asyncio
async def test_websocket_origin_validation(test_client):
    """Test WebSocket rejects invalid origins."""
    with pytest.raises(Exception):
        # Should fail without chrome-extension:// origin
        with test_client.websocket_connect("/ws", headers={"origin": "http://evil.com"}):
            pass
```

### Manual Test Scenarios

| # | Scenario | Expected Result |
|---|----------|-----------------|
| 1 | Start service → connect extension | Status shows "Connected" ✅ |
| 2 | Click element → send message | Response in <2s total ⚡ |
| 3 | Multi-turn conversation | History maintained ✅ |
| 4 | Screenshot capture | Saved to `.ui-chatter/screenshots/` ✅ |
| 5 | Code modification → hot reload | Vite reloads automatically ✅ |

---

## Implementation Plan

**Revised Timeline:** 3-4 weeks (based on FastAPI expert review)

### Phase 1: Core Infrastructure (Week 1, Days 1-5)

- [ ] Scaffold Python project with UV
  - [ ] Create pyproject.toml with all dependencies
  - [ ] Setup .python-version
  - [ ] Initialize UV virtual environment
- [ ] Implement core components:
  - [ ] Configuration management (pydantic-settings)
  - [ ] Logging setup
  - [ ] Exception classes
  - [ ] Models and schemas
- [ ] WebSocket connection manager
  - [ ] Origin validation
  - [ ] Connection limits
  - [ ] Message routing
- [ ] Agent manager with proper lifecycle
  - [ ] Lazy initialization
  - [ ] Error handling
  - [ ] Graceful shutdown

**Deliverable:** Basic service that accepts WebSocket connections

### Phase 2: Agent Integration (Week 2, Days 6-10)

- [ ] Session manager
  - [ ] Multi-session support
  - [ ] Automatic cleanup
  - [ ] Background tasks
- [ ] Agent SDK integration
  - [ ] Chat handling
  - [ ] Response streaming
  - [ ] Error recovery
- [ ] FastAPI application
  - [ ] Lifespan management
  - [ ] Health endpoint
  - [ ] WebSocket endpoint
- [ ] Test with POC Chrome extension
- [ ] Verify <1s latency ⚡

**Deliverable:** Working end-to-end chat with extension

### Phase 3: Features & Polish (Week 2-3, Days 11-15)

- [ ] Screenshot storage
  - [ ] Async save/load
  - [ ] Automatic cleanup
- [ ] CLI interface (Typer)
  - [ ] Signal handling
  - [ ] Health checks
  - [ ] Rich output
- [ ] Middleware
  - [ ] CORS
  - [ ] Error handling
- [ ] Auto-gitignore setup
- [ ] Prompt building

**Deliverable:** Feature-complete MVP

### Phase 4: Testing & Documentation (Week 3-4, Days 16-20)

- [ ] Unit tests
  - [ ] Agent manager tests
  - [ ] Session manager tests
  - [ ] Screenshot store tests
  - [ ] Prompt builder tests
- [ ] Integration tests
  - [ ] WebSocket flow tests
  - [ ] Multi-session tests
  - [ ] Error scenario tests
- [ ] Test fixtures and mocks
  - [ ] Mock Agent SDK
  - [ ] Temp project setup
  - [ ] WebSocket client
- [ ] Documentation
  - [ ] README with setup guide
  - [ ] API documentation
  - [ ] Development guide
  - [ ] Troubleshooting
- [ ] Manual testing on real projects
- [ ] Performance benchmarks

**Deliverable:** Production-ready service with >80% test coverage

---

## Success Metrics

| Metric | Target | How to Measure |
|--------|--------|----------------|
| **Latency** | <1s first token | Server logs + timer |
| **Memory** | <500MB idle | `ps aux \| grep python` |
| **Extension reuse** | 100% | No code changes needed |
| **Settings** | Full inheritance | Test with various `.claude/settings.json` |
| **Reliability** | No crashes in 100 chats | Stress testing |

---

## Changes from Expert Review (2026-01-25)

This specification was reviewed by the FastAPI expert and significantly enhanced based on production best practices:

### Critical Fixes Applied (Priority 1):

1. **✅ WebSocket Connection Management** - Added `ConnectionManager` class with:
   - Origin validation (`chrome-extension://` only)
   - Connection limits (max 100 concurrent)
   - Proper lifecycle management

2. **✅ Agent Lifecycle Management** - Redesigned `AgentManager` with:
   - Lazy initialization using async locks
   - Proper error handling (auth, rate limit, timeout)
   - Graceful shutdown support

3. **✅ Session Management** - Added `SessionManager` class with:
   - Multi-session isolation
   - Automatic idle session cleanup (background task)
   - Resource management

4. **✅ Updated Dependencies** - Switched to UV package manager with latest versions:
   - FastAPI 0.115.0+ (was 0.109.0)
   - Uvicorn 0.32.0+ (was 0.27.0)
   - Pydantic 2.10.0+ (was 2.6.0)
   - Added: pydantic-settings, Typer, aiofiles, Pillow

5. **✅ Error Handling** - Comprehensive exception handling:
   - Custom exception classes
   - Graceful degradation
   - User-friendly error messages

6. **✅ Production Testing** - Complete pytest setup:
   - Async test support
   - Mock fixtures for Agent SDK
   - Integration test patterns
   - Coverage configuration

7. **✅ Async Screenshot Processing** - Non-blocking I/O:
   - Thread pool for base64 decode
   - Async file writes
   - Prevents event loop blocking

### Additional Improvements (Priority 2):

8. **✅ Configuration Management** - Pydantic settings with environment variables
9. **✅ CLI with Typer** - Replaced Click with modern Typer + Rich output
10. **✅ Lifespan Management** - FastAPI lifespan for startup/shutdown
11. **✅ Logging Configuration** - Structured logging setup
12. **✅ Project Structure** - Separated schemas from models, added middleware

### Timeline Impact:

- **Original estimate**: 2-3 weeks
- **Revised estimate**: **3-4 weeks** (more realistic with production features)
- Breakdown:
  - Week 1: Core infrastructure (5 days)
  - Week 2: Agent integration (5 days)
  - Week 2-3: Features & polish (5 days)
  - Week 3-4: Testing & docs (5 days)

---

## Risks and Mitigation

| Risk | Mitigation |
|------|-----------|
| Agent SDK API changes | Pin SDK version, monitor releases |
| Memory leaks | Implement session cleanup, monitor memory |
| WebSocket disconnects | Client auto-reconnect (already in POC) |
| Screenshot disk usage | Auto-cleanup, configurable retention |
| OAuth expiration | Agent SDK handles refresh automatically |

---

## Open Questions

1. **Multi-project support** - One service instance per project, or global service?
   - **Recommendation**: One per project (simpler, isolated)

2. **Conversation history** - SQLite local, or agent-managed?
   - **Recommendation**: Agent SDK manages (already built-in)

3. **Screenshot optimization** - Store full or crop to element?
   - **Recommendation**: Start with full, optimize later

4. **Hot reload detection** - Active monitoring or passive?
   - **Recommendation**: Passive (frameworks already handle this)

---

## Appendix

### POC Learnings

From TS-0001, we learned:

✅ **Keep**:
- Chrome extension architecture
- WebSocket protocol
- DOM extraction logic
- Side panel UI

🔄 **Change**:
- Subprocess → In-process (Agent SDK)
- Node.js → Python (better SDK support)
- Custom spawning → SDK-managed agent

### References

- [Agent SDK Documentation](https://github.com/anthropics/anthropic-sdk-python)
- [POC Results](../../poc/POC-RESULTS.md)
- [ADR-0001](../../docs/decisions/ADR-0001-use-agent-sdk-over-acp.md)
- [Integration Points](../../docs/tech-brainstorm/2026-01-08-ui-context-bridge/integration-points.md)
