"""Multi-session management with automatic cleanup."""

import asyncio
import logging
from datetime import datetime, timedelta
from typing import Dict, Optional, List, TYPE_CHECKING

from .backends import AgentBackend, ClaudeAgentSDKBackend

if TYPE_CHECKING:
    from .session_store import SessionStore
    from .session_repository import SessionRepository, ClaudeMessage

logger = logging.getLogger(__name__)


class AgentSession:
    """Represents a single agent session with state."""

    def __init__(
        self,
        session_id: str,
        project_path: str,
        backend: AgentBackend,
        permission_mode: str = "plan"
    ):
        self.session_id = session_id
        self.project_path = project_path
        self.created_at = datetime.now()
        self.last_activity = datetime.now()
        self.backend = backend
        self.permission_mode = permission_mode
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
    - Claude Agent SDK backend (subscription-based authentication)
    """

    def __init__(
        self,
        max_idle_minutes: int = 30,
        project_path: str = ".",
        permission_mode: str = "bypassPermissions",
        session_store: Optional["SessionStore"] = None,
        session_repository: Optional["SessionRepository"] = None,
    ):
        self.max_idle_minutes = max_idle_minutes
        self.project_path = project_path
        self.permission_mode = permission_mode
        self.sessions: Dict[str, AgentSession] = {}
        self._cleanup_task: Optional[asyncio.Task] = None
        self.session_store = session_store
        self.session_repository = session_repository

        logger.info(f"Initialized SessionManager with Claude Agent SDK, project: {project_path}")

    def _create_backend(
        self,
        session_id: str,
        project_path: str,
        permission_mode: Optional[str] = None
    ) -> AgentBackend:
        """Create ClaudeAgentSDKBackend (only backend)."""
        mode = permission_mode or self.permission_mode

        logger.info(f"Creating Claude Agent SDK backend with permission mode: {mode}")
        return ClaudeAgentSDKBackend(
            project_path=project_path,
            permission_mode=mode
        )

    async def create_session(
        self,
        session_id: str,
        permission_mode: Optional[str] = None
    ) -> AgentSession:
        """Create new isolated agent session with configured backend."""
        mode = permission_mode or self.permission_mode

        backend = self._create_backend(session_id, self.project_path, permission_mode=mode)
        session = AgentSession(session_id, self.project_path, backend, permission_mode=mode)
        self.sessions[session_id] = session

        # Persist metadata to SQLite
        if self.session_store:
            await self.session_store.save_session(
                session_id=session_id,
                project_path=self.project_path,
                backend_type="claude-agent-sdk",
                permission_mode=mode,
                created_at=session.created_at,
            )

        logger.info(
            f"Created session: {session_id} with Claude Agent SDK backend "
            f"(permission mode: {mode}) for project: {self.project_path}"
        )
        return session

    async def get_session(self, session_id: str) -> Optional[AgentSession]:
        """Get existing session and update activity."""
        session = self.sessions.get(session_id)
        if session:
            session.touch()
            # Update activity in store
            if self.session_store:
                await self.session_store.update_session_activity(session_id)
        return session

    async def remove_session(self, session_id: str) -> None:
        """Remove and cleanup session."""
        session = self.sessions.pop(session_id, None)
        if session:
            await session.backend.shutdown()
            # Delete from store
            if self.session_store:
                await self.session_store.delete_session(session_id)
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

    async def get_conversation_history(self, session_id: str) -> List["ClaudeMessage"]:
        """Get conversation history from Claude Code's storage."""
        if not self.session_repository:
            return []

        return self.session_repository.get_messages(session_id)

    async def recover_sessions(self) -> int:
        """Recover active sessions from store."""
        if not self.session_store:
            return 0

        active_sessions = await self.session_store.get_active_sessions()

        recovered_count = 0
        for session_data in active_sessions:
            try:
                session_id = session_data["session_id"]

                if session_id in self.sessions:
                    continue

                # Get permission mode from stored data or use default
                permission_mode = session_data.get("permission_mode") or self.permission_mode

                # Reconstruct backend with stored permission mode
                backend = self._create_backend(
                    session_id,
                    session_data["project_path"],
                    permission_mode=permission_mode
                )

                # Create session object
                session = AgentSession(
                    session_id,
                    session_data["project_path"],
                    backend,
                    permission_mode=permission_mode
                )
                session.created_at = datetime.fromisoformat(session_data["created_at"])
                session.last_activity = datetime.fromisoformat(session_data["last_activity"])
                session.first_message_sent = bool(session_data["first_message_sent"])

                self.sessions[session_id] = session
                recovered_count += 1

                logger.info(f"Recovered session {session_id}")

            except Exception as e:
                logger.error(f"Failed to recover session: {e}")

        return recovered_count

    async def mark_first_message_sent(self, session_id: str) -> None:
        """Mark that first message has been sent in both session and store."""
        session = self.sessions.get(session_id)
        if session:
            session.mark_first_message_sent()

        if self.session_store:
            await self.session_store.mark_first_message_sent(session_id)

    async def update_permission_mode(self, session_id: str, new_mode: str) -> None:
        """Update permission mode for existing session."""
        session = self.sessions.get(session_id)
        if not session:
            raise ValueError(f"Session {session_id} not found")

        # Update session state
        session.permission_mode = new_mode

        # Recreate backend with new permission mode
        session.backend = self._create_backend(
            session_id,
            self.project_path,
            permission_mode=new_mode
        )

        # Persist change to database
        if self.session_store:
            await self.session_store.update_permission_mode(session_id, new_mode)

        logger.info(f"Updated permission mode to {new_mode} for session {session_id}")
