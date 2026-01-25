"""Multi-session management with automatic cleanup."""

import asyncio
import logging
from datetime import datetime, timedelta
from typing import Dict, Optional

from .agent_manager import AgentManager

logger = logging.getLogger(__name__)


class AgentSession:
    """Represents a single agent session with state."""

    def __init__(self, session_id: str, project_path: str, api_key: Optional[str] = None):
        self.session_id = session_id
        self.project_path = project_path
        self.created_at = datetime.now()
        self.last_activity = datetime.now()
        self.agent_manager = AgentManager(project_path, api_key)

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
    """

    def __init__(self, max_idle_minutes: int = 30, api_key: Optional[str] = None):
        self.max_idle_minutes = max_idle_minutes
        self.api_key = api_key
        self.sessions: Dict[str, AgentSession] = {}
        self._cleanup_task: Optional[asyncio.Task] = None

    async def create_session(self, session_id: str, project_path: str) -> AgentSession:
        """Create new isolated agent session."""
        session = AgentSession(session_id, project_path, self.api_key)
        self.sessions[session_id] = session
        logger.info(f"Created session: {session_id}")
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
            await session.agent_manager.shutdown()
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
