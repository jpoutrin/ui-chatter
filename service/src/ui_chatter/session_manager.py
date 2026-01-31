"""Multi-session management with automatic cleanup."""

import asyncio
import logging
from datetime import datetime, timedelta
from typing import Dict, Optional, List, TYPE_CHECKING

from .backends import AgentBackend, ClaudeAgentSDKBackend
from .models.messages import PermissionMode
from .types import WsSendCallback

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
        permission_mode: PermissionMode = "plan",
        ws_send_callback: Optional[WsSendCallback] = None
    ) -> None:
        self.session_id = session_id
        self.project_path = project_path
        self.created_at = datetime.now()
        self.last_activity = datetime.now()
        self.backend = backend
        self.permission_mode = permission_mode
        self.ws_send_callback = ws_send_callback  # Store callback for backend recreation
        # NOTE: first_message_sent removed - using backend.has_established_session instead
        self.cancel_event: Optional[asyncio.Event] = None

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
        permission_mode: PermissionMode = "bypassPermissions",
        session_store: Optional["SessionStore"] = None,
        session_repository: Optional["SessionRepository"] = None,
    ):
        self.max_idle_minutes = max_idle_minutes
        self.project_path = project_path
        self.permission_mode = permission_mode
        self.sessions: Dict[str, AgentSession] = {}
        self._cleanup_task: Optional[asyncio.Task[None]] = None
        self.session_store = session_store
        self.session_repository = session_repository

        logger.info(f"Initialized SessionManager with Claude Agent SDK, project: {project_path}")

    def _create_backend(
        self,
        session_id: str,
        project_path: str,
        permission_mode: Optional[PermissionMode] = None,
        resume_session_id: Optional[str] = None,
        fork_session: bool = False,
        ws_send_callback: Optional[WsSendCallback] = None
    ) -> AgentBackend:
        """Create ClaudeAgentSDKBackend (only backend)."""
        mode = permission_mode or self.permission_mode

        logger.info(f"Creating Claude Agent SDK backend with permission mode: {mode}, resume_session_id: {resume_session_id}, fork={fork_session}")
        return ClaudeAgentSDKBackend(
            project_path=project_path,
            permission_mode=mode,
            resume_session_id=resume_session_id,
            fork_session=fork_session,
            ws_send_callback=ws_send_callback
        )

    async def create_session(
        self,
        session_id: str,
        permission_mode: Optional[PermissionMode] = None,
        sdk_session_id: Optional[str] = None,
        page_url: Optional[str] = None,
        tab_id: Optional[str] = None,
        auto_resume: bool = True,
        ws_send_callback: Optional[WsSendCallback] = None,
    ) -> AgentSession:
        """
        Create new isolated agent session with configured backend.

        If auto_resume=True and page_url+tab_id provided, attempts to
        resume existing session for same context.
        """
        from .utils.url_utils import normalize_url_for_matching
        from .config import settings

        mode = permission_mode or self.permission_mode
        resumed = False

        # Attempt auto-resume if enabled and context provided
        if auto_resume and settings.AUTO_RESUME_ENABLED and page_url and tab_id and self.session_store:
            base_url: Optional[str] = normalize_url_for_matching(page_url)
            assert base_url is not None, "normalize_url_for_matching returned None for truthy page_url"

            # Check if other tabs have active conversations for this URL
            other_tabs_active = await self.session_store.has_other_active_tabs(
                base_url=base_url,
                current_tab_id=tab_id,
                max_age_minutes=settings.AUTO_RESUME_MAX_AGE_MINUTES
            )

            if other_tabs_active:
                # Other tabs active → create new session for this tab
                logger.info(
                    f"Other tabs active for {base_url}, creating new session for tab {tab_id}"
                )
            else:
                # No other tabs → resume most recent session
                resumable = await self.session_store.find_resumable_session(
                    base_url=base_url,
                    max_age_minutes=settings.AUTO_RESUME_MAX_AGE_MINUTES
                )

                if resumable:
                    sdk_session_id = resumable.get('sdk_session_id')
                    resumed = True
                    logger.info(
                        f"Auto-resuming session {resumable['session_id']} "
                        f"(SDK: {sdk_session_id}) for {base_url} (no other tabs active)"
                    )

        # For new sessions: Don't pass sdk_session_id (will be captured from SDK)
        # For resumed sessions: Pass resume_session_id
        backend = self._create_backend(
            session_id,
            self.project_path,
            permission_mode=mode,
            resume_session_id=sdk_session_id if sdk_session_id else None,
            ws_send_callback=ws_send_callback
        )
        session = AgentSession(session_id, self.project_path, backend, permission_mode=mode, ws_send_callback=ws_send_callback)
        self.sessions[session_id] = session

        # Initialize slash commands proactively for autocomplete
        if hasattr(backend, 'initialize_slash_commands'):
            try:
                await backend.initialize_slash_commands()
            except Exception as e:
                logger.warning(f"Failed to initialize slash commands: {e}")

        # Persist metadata to SQLite with URL context
        if self.session_store:
            base_url = normalize_url_for_matching(page_url) if page_url else None

            await self.session_store.save_session(
                session_id=session_id,
                sdk_session_id=sdk_session_id,  # May be None for new sessions
                project_path=self.project_path,
                backend_type="claude-agent-sdk",
                permission_mode=mode,
                created_at=session.created_at,
                page_url=page_url,
                base_url=base_url,
                tab_id=tab_id,
            )

        logger.info(
            f"{'Resumed' if resumed else 'Created'} session: {session_id} with Claude Agent SDK backend "
            f"(permission mode: {mode}, sdk_session_id: {sdk_session_id or 'will be captured'}) for project: {self.project_path}"
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

    async def update_sdk_session_id(self, session_id: str, sdk_session_id: str) -> None:
        """
        Update SDK session ID after backend establishes it.

        Called when backend emits session_established message.

        Args:
            session_id: WebSocket session ID
            sdk_session_id: SDK session ID from SystemMessage
        """
        # Update in-memory session
        session = self.sessions.get(session_id)
        if session and self.session_store:
            # Backend already has it set, just persist to DB
            await self.session_store.set_sdk_session_id(session_id, sdk_session_id)
            logger.info(
                f"[SESSION MANAGER] Persisted SDK session ID {sdk_session_id} "
                f"for session {session_id}"
            )

    async def switch_sdk_session(
        self,
        session_id: str,
        new_sdk_session_id: str
    ) -> None:
        """
        Switch an existing WebSocket session to use a different SDK session.

        This recreates the backend with the new SDK session ID.
        """
        session = self.sessions.get(session_id)
        if not session:
            raise ValueError(f"Session {session_id} not found")

        # Shutdown old backend
        await session.backend.shutdown()

        # Create new backend with resume_session_id (to resume existing SDK session)
        new_backend = self._create_backend(
            session_id,
            session.project_path,
            permission_mode=session.permission_mode,
            resume_session_id=new_sdk_session_id  # Resume existing SDK session
        )

        # Update session with new backend
        session.backend = new_backend

        # Update store
        if self.session_store:
            await self.session_store.set_sdk_session_id(session_id, new_sdk_session_id)

        logger.info(f"Switched session {session_id} to SDK session {new_sdk_session_id}")

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
        if not self.session_repository or not self.session_store:
            return []

        # Get SDK session ID from database (JSONL files are named with SDK session ID)
        sdk_session_id = await self.session_store.get_sdk_session_id(session_id)
        if not sdk_session_id:
            # No SDK session established yet
            return []

        return self.session_repository.get_messages(sdk_session_id)

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

                # Get SDK session ID from stored data (may be None for new sessions)
                sdk_session_id = session_data.get("sdk_session_id")

                # Reconstruct backend with stored permission mode
                # If we have an SDK session ID, pass it as resume_session_id
                backend = self._create_backend(
                    session_id,
                    session_data["project_path"],
                    permission_mode=permission_mode,
                    resume_session_id=sdk_session_id
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
                # NOTE: first_message_sent removed - using backend.has_established_session instead

                self.sessions[session_id] = session
                recovered_count += 1

                logger.info(f"Recovered session {session_id}")

            except Exception as e:
                logger.error(f"Failed to recover session: {e}")

        return recovered_count

    async def update_permission_mode(self, session_id: str, new_mode: PermissionMode) -> None:
        """Update permission mode for existing session."""
        session = self.sessions.get(session_id)
        if not session:
            raise ValueError(f"Session {session_id} not found")

        # Update session state
        session.permission_mode = new_mode

        # Cleanup old backend before recreating
        if hasattr(session.backend, 'shutdown'):
            await session.backend.shutdown()

        # Recreate backend with new permission mode
        # IMPORTANT: Fork the SDK session when changing permission mode to preserve context
        # fork_session=True creates a new session with the conversation history but new settings
        resume_session_id = session.backend.sdk_session_id if session.backend.has_established_session else None
        session.backend = self._create_backend(
            session_id,
            self.project_path,
            permission_mode=new_mode,
            resume_session_id=resume_session_id,  # Resume to fork from
            fork_session=True,  # Fork preserves context with new mode
            ws_send_callback=session.ws_send_callback
        )

        # Persist change to database
        if self.session_store:
            await self.session_store.update_permission_mode(session_id, new_mode)

        logger.info(f"Updated permission mode to {new_mode} for session {session_id}")
