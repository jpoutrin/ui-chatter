"""Multi-session management with automatic cleanup."""

import asyncio
import logging
from datetime import datetime, timedelta
from typing import Dict, Optional, Literal

from .backends import AgentBackend, AnthropicSDKBackend, ClaudeCodeCLIBackend

logger = logging.getLogger(__name__)


class AgentSession:
    """Represents a single agent session with state."""

    def __init__(self, session_id: str, project_path: str, backend: AgentBackend):
        self.session_id = session_id
        self.project_path = project_path
        self.created_at = datetime.now()
        self.last_activity = datetime.now()
        self.backend = backend
        self.first_message_sent = False  # Track if first message has been sent

    def mark_first_message_sent(self) -> None:
        """Mark that the first message has been sent for this session."""
        self.first_message_sent = True
        self.touch()

    def is_first_message(self) -> bool:
        """Check if this is the first message for this session."""
        return not self.first_message_sent

    def touch(self) -> None:
        """Update last activity timestamp."""
        self.last_activity = datetime.now()


class SessionManager:
    """
    Manages multiple agent sessions with automatic cleanup.

    Features:
    - Session isolation
    - Automatic idle session cleanup
    - Resource management
    - Backend strategy support (Anthropic SDK or Claude CLI)
    """

    def __init__(
        self,
        max_idle_minutes: int = 30,
        backend_strategy: Literal["anthropic-sdk", "claude-cli"] = "claude-cli",
        api_key: Optional[str] = None,
        project_path: str = ".",
        permission_mode: str = "bypassPermissions",
    ):
        self.max_idle_minutes = max_idle_minutes
        self.backend_strategy = backend_strategy
        self.api_key = api_key
        self.project_path = project_path
        self.permission_mode = permission_mode
        self.sessions: Dict[str, AgentSession] = {}
        self._cleanup_task: Optional[asyncio.Task] = None

        logger.info(f"Initialized SessionManager with backend: {backend_strategy}, project: {project_path}")

    def _create_backend(self, session_id: str, project_path: str) -> AgentBackend:
        """Create appropriate backend based on strategy."""
        if self.backend_strategy == "anthropic-sdk":
            logger.info("Creating Anthropic SDK backend")
            return AnthropicSDKBackend(project_path, api_key=self.api_key)
        elif self.backend_strategy == "claude-cli":
            logger.info("Creating Claude Code CLI backend")
            return ClaudeCodeCLIBackend(
                project_path, session_id=session_id, permission_mode=self.permission_mode
            )
        else:
            raise ValueError(f"Unknown backend strategy: {self.backend_strategy}")

    async def create_session(self, session_id: str) -> AgentSession:
        """Create new isolated agent session with configured backend."""
        backend = self._create_backend(session_id, self.project_path)
        session = AgentSession(session_id, self.project_path, backend)
        self.sessions[session_id] = session
        logger.info(
            f"Created session: {session_id} with {self.backend_strategy} backend for project: {self.project_path}"
        )
        return session

    async def get_session(self, session_id: str) -> Optional[AgentSession]:
        """Get existing session and update activity."""
        session = self.sessions.get(session_id)
        if session:
            session.touch()
        return session

    async def remove_session(self, session_id: str) -> None:
        """Remove and cleanup session."""
        session = self.sessions.pop(session_id, None)
        if session:
            await session.backend.shutdown()
            logger.info(f"Removed session: {session_id}")

    def start_cleanup_task(self) -> None:
        """Start background cleanup task."""
        if self._cleanup_task is None:
            self._cleanup_task = asyncio.create_task(self._cleanup_loop())
            logger.info("Session cleanup task started")

    async def _cleanup_loop(self) -> None:
        """Background task to cleanup idle sessions."""
        while True:
            try:
                await asyncio.sleep(60)  # Check every minute
                await self._cleanup_idle_sessions()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in cleanup loop: {e}", exc_info=True)

    async def _cleanup_idle_sessions(self) -> None:
        """Remove sessions idle for too long."""
        cutoff = datetime.now() - timedelta(minutes=self.max_idle_minutes)
        to_remove = [
            sid
            for sid, session in self.sessions.items()
            if session.last_activity < cutoff
        ]

        for sid in to_remove:
            logger.info(f"Removing idle session: {sid}")
            await self.remove_session(sid)

    async def cleanup_all_sessions(self) -> None:
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

    def get_session_count(self) -> int:
        """Get number of active sessions."""
        return len(self.sessions)
