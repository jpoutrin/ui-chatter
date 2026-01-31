"""SQLite store for UI Chatter session metadata (not messages)."""

import aiosqlite
import asyncio
import logging
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Optional, Any

logger = logging.getLogger(__name__)


class SessionStore:
    """
    Lightweight SQLite store for session metadata.

    Does NOT store messages - those are read from Claude Code's storage.
    Only tracks which sessions belong to UI Chatter and their configuration.
    """

    def __init__(self, project_path: str):
        self.db_path = Path(project_path) / ".ui-chatter" / "sessions.db"
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialized = False
        self._lock = asyncio.Lock()

    async def initialize(self) -> None:
        """Initialize database schema (idempotent)."""
        async with self._lock:
            if self._initialized:
                return

            async with aiosqlite.connect(self.db_path) as db:
                # First, check if table exists and if so, check for sdk_session_id column
                cursor = await db.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'"
                )
                table_exists = await cursor.fetchone()

                if table_exists:
                    # Table exists, check if migration is needed
                    cursor = await db.execute("PRAGMA table_info(sessions)")
                    columns = await cursor.fetchall()
                    column_names = [col[1] for col in columns]

                    if "sdk_session_id" not in column_names:
                        logger.info("Migrating sessions table: adding sdk_session_id column")
                        await db.execute("ALTER TABLE sessions ADD COLUMN sdk_session_id TEXT")
                        await db.commit()
                        logger.info("Migration complete: sdk_session_id column added")

                    # Migration: Remove first_message_sent column if it exists
                    if "first_message_sent" in column_names:
                        await self._migrate_remove_first_message_sent(db)

                    # Migration: Add auto-resume columns
                    if "page_url" not in column_names:
                        logger.info("Migrating: Adding auto-resume columns")
                        await db.execute("ALTER TABLE sessions ADD COLUMN page_url TEXT")
                        await db.execute("ALTER TABLE sessions ADD COLUMN base_url TEXT")
                        await db.execute("ALTER TABLE sessions ADD COLUMN tab_id TEXT")
                        await db.commit()
                        logger.info("Migration complete: auto-resume columns added")

                # Create table without first_message_sent column (for new databases)
                await db.execute("""
                    CREATE TABLE IF NOT EXISTS sessions (
                        session_id TEXT PRIMARY KEY,
                        sdk_session_id TEXT,
                        project_path TEXT NOT NULL,
                        backend_type TEXT NOT NULL,
                        permission_mode TEXT,
                        status TEXT NOT NULL DEFAULT 'active',
                        title TEXT DEFAULT 'Untitled',
                        created_at TEXT NOT NULL,
                        last_activity TEXT NOT NULL,
                        page_url TEXT,
                        base_url TEXT,
                        tab_id TEXT
                    )
                """)

                await db.execute("""
                    CREATE INDEX IF NOT EXISTS idx_sessions_status
                    ON sessions(status)
                """)

                await db.execute("""
                    CREATE INDEX IF NOT EXISTS idx_sessions_last_activity
                    ON sessions(last_activity)
                """)

                await db.execute("""
                    CREATE INDEX IF NOT EXISTS idx_sessions_title
                    ON sessions(title)
                """)

                await db.execute("""
                    CREATE INDEX IF NOT EXISTS idx_sessions_sdk_session_id
                    ON sessions(sdk_session_id)
                """)

                # Create index for auto-resume lookups
                await db.execute("""
                    CREATE INDEX IF NOT EXISTS idx_sessions_base_url_tab
                    ON sessions(base_url, tab_id, last_activity)
                """)

                await db.commit()
                logger.info(f"SessionStore initialized at {self.db_path}")
                self._initialized = True

    async def _migrate_remove_first_message_sent(self, db: aiosqlite.Connection) -> None:
        """Remove deprecated first_message_sent column."""
        try:
            logger.info("Migrating: Removing first_message_sent column")

            # SQLite doesn't support DROP COLUMN, so recreate table
            await db.execute("""
                CREATE TABLE sessions_new (
                    session_id TEXT PRIMARY KEY,
                    sdk_session_id TEXT,
                    project_path TEXT NOT NULL,
                    backend_type TEXT NOT NULL,
                    permission_mode TEXT,
                    status TEXT NOT NULL DEFAULT 'active',
                    title TEXT DEFAULT 'Untitled',
                    created_at TEXT NOT NULL,
                    last_activity TEXT NOT NULL
                )
            """)

            # Copy data
            await db.execute("""
                INSERT INTO sessions_new
                SELECT session_id, sdk_session_id, project_path,
                       backend_type, permission_mode, status, title,
                       created_at, last_activity
                FROM sessions
            """)

            # Replace tables
            await db.execute("DROP TABLE sessions")
            await db.execute("ALTER TABLE sessions_new RENAME TO sessions")

            # Recreate indexes
            await db.execute("""
                CREATE INDEX IF NOT EXISTS idx_sessions_status
                ON sessions(status)
            """)
            await db.execute("""
                CREATE INDEX IF NOT EXISTS idx_sessions_last_activity
                ON sessions(last_activity)
            """)
            await db.execute("""
                CREATE INDEX IF NOT EXISTS idx_sessions_title
                ON sessions(title)
            """)
            await db.execute("""
                CREATE INDEX IF NOT EXISTS idx_sessions_sdk_session_id
                ON sessions(sdk_session_id)
            """)

            await db.commit()
            logger.info("Migration complete: first_message_sent column removed")
        except Exception as e:
            logger.error(f"Migration failed: {e}")
            # Don't raise - allow service to continue

    async def save_session(
        self,
        session_id: str,
        project_path: str,
        backend_type: str,
        permission_mode: Optional[str] = None,
        sdk_session_id: Optional[str] = None,
        created_at: Optional[datetime] = None,
        status: str = "active",
        page_url: Optional[str] = None,
        base_url: Optional[str] = None,
        tab_id: Optional[str] = None,
    ) -> None:
        """Save or update session metadata."""
        await self.initialize()

        now = datetime.now()
        created_at = created_at or now

        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                """
                INSERT INTO sessions
                    (session_id, sdk_session_id, project_path, backend_type, permission_mode,
                     status, created_at, last_activity, page_url, base_url, tab_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET
                    sdk_session_id = COALESCE(excluded.sdk_session_id, sessions.sdk_session_id),
                    project_path = excluded.project_path,
                    backend_type = excluded.backend_type,
                    permission_mode = excluded.permission_mode,
                    status = excluded.status,
                    last_activity = excluded.last_activity,
                    page_url = excluded.page_url,
                    base_url = excluded.base_url,
                    tab_id = excluded.tab_id
                """,
                (
                    session_id,
                    sdk_session_id,
                    project_path,
                    backend_type,
                    permission_mode,
                    status,
                    created_at.isoformat(),
                    now.isoformat(),
                    page_url,
                    base_url,
                    tab_id,
                ),
            )
            await db.commit()

    async def get_session(self, session_id: str) -> Optional[Dict[str, Any]]:
        """Retrieve session metadata."""
        await self.initialize()

        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT * FROM sessions WHERE session_id = ?", (session_id,)
            ) as cursor:
                row = await cursor.fetchone()
                if row:
                    return dict(row)
                return None

    async def update_session_activity(self, session_id: str) -> None:
        """Update last_activity timestamp."""
        await self.initialize()

        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                "UPDATE sessions SET last_activity = ? WHERE session_id = ?",
                (datetime.now().isoformat(), session_id),
            )
            await db.commit()

    async def update_permission_mode(self, session_id: str, mode: str) -> None:
        """Update permission mode for a session."""
        await self.initialize()

        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                """
                UPDATE sessions
                SET permission_mode = ?, last_activity = ?
                WHERE session_id = ?
                """,
                (mode, datetime.now().isoformat(), session_id),
            )
            await db.commit()
            logger.info(f"Updated permission mode to {mode} for session {session_id}")

    async def delete_session(self, session_id: str) -> None:
        """Mark session as inactive (soft delete to preserve SDK session ID mapping)."""
        await self.initialize()

        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                """
                UPDATE sessions
                SET status = 'inactive'
                WHERE session_id = ?
                """,
                (session_id,)
            )
            await db.commit()
            logger.info(f"Marked session {session_id} as inactive (preserving SDK session mapping)")

    async def permanently_delete_session(self, session_id: str) -> None:
        """Permanently delete session from database (hard delete)."""
        await self.initialize()

        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                "DELETE FROM sessions WHERE session_id = ?", (session_id,)
            )
            await db.commit()
            logger.info(f"Permanently deleted session {session_id}")

    async def get_active_sessions(self) -> List[Dict[str, Any]]:
        """Get all active sessions for recovery."""
        await self.initialize()

        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                """
                SELECT
                    session_id,
                    sdk_session_id,
                    title,
                    project_path,
                    backend_type,
                    permission_mode,
                    status,
                    created_at,
                    last_activity
                FROM sessions
                WHERE status = 'active'
                ORDER BY last_activity DESC
                """
            ) as cursor:
                rows = await cursor.fetchall()
                return [dict(row) for row in rows]

    async def set_session_title(self, session_id: str, title: str) -> None:
        """Set or update session title."""
        await self.initialize()

        # Truncate title to 100 characters max
        truncated_title = title[:100] if len(title) > 100 else title

        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                """
                UPDATE sessions
                SET title = ?, last_activity = ?
                WHERE session_id = ?
                """,
                (truncated_title, datetime.now().isoformat(), session_id),
            )
            await db.commit()
            logger.info(f"Updated title for session {session_id}: {truncated_title}")

    async def get_sdk_session_id(self, session_id: str) -> Optional[str]:
        """Get SDK session_id for a UI Chatter session."""
        await self.initialize()

        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT sdk_session_id FROM sessions WHERE session_id = ?",
                (session_id,)
            ) as cursor:
                row = await cursor.fetchone()
                return row["sdk_session_id"] if row and row["sdk_session_id"] else None

    async def set_sdk_session_id(
        self, session_id: str, sdk_session_id: str
    ) -> None:
        """Link UI Chatter session to SDK session."""
        await self.initialize()

        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                "UPDATE sessions SET sdk_session_id = ? WHERE session_id = ?",
                (sdk_session_id, session_id)
            )
            await db.commit()
            logger.info(f"Linked session {session_id} to SDK session {sdk_session_id}")

    async def get_all_sdk_sessions(self) -> List[Dict[str, Any]]:
        """Get all sessions with their SDK session IDs."""
        await self.initialize()

        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                """
                SELECT
                    session_id,
                    sdk_session_id,
                    title,
                    status,
                    created_at,
                    last_activity
                FROM sessions
                WHERE sdk_session_id IS NOT NULL
                ORDER BY last_activity DESC
                """
            ) as cursor:
                rows = await cursor.fetchall()
                return [dict(row) for row in rows]

    async def search_sessions(self, query: str) -> List[Dict[str, Any]]:
        """Search sessions by title."""
        await self.initialize()

        # Escape SQL LIKE special characters
        escaped_query = query.replace("%", "\\%").replace("_", "\\_")
        search_pattern = f"%{escaped_query}%"

        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                """
                SELECT * FROM sessions
                WHERE status = 'active'
                  AND title LIKE ? ESCAPE '\\'
                ORDER BY last_activity DESC
                LIMIT 50
                """,
                (search_pattern,),
            ) as cursor:
                rows = await cursor.fetchall()
                return [dict(row) for row in rows]

    async def archive_old_sessions(self, max_age_hours: int) -> int:
        """Archive inactive sessions."""
        await self.initialize()

        cutoff = datetime.now() - timedelta(hours=max_age_hours)

        async with aiosqlite.connect(self.db_path) as db:
            cursor = await db.execute(
                """
                UPDATE sessions
                SET status = 'archived'
                WHERE status = 'active'
                  AND last_activity < ?
                """,
                (cutoff.isoformat(),),
            )
            count = cursor.rowcount
            await db.commit()

            if count > 0:
                logger.info(f"Archived {count} old session(s)")

            return count

    async def delete_old_inactive_sessions(self, max_age_days: int = 30) -> int:
        """
        Permanently delete very old inactive/archived sessions.

        This prevents the database from growing indefinitely while preserving
        recent session history for recovery.

        Args:
            max_age_days: Delete sessions older than this many days (default: 30)

        Returns:
            Number of sessions deleted
        """
        await self.initialize()

        cutoff = datetime.now() - timedelta(days=max_age_days)

        async with aiosqlite.connect(self.db_path) as db:
            cursor = await db.execute(
                """
                DELETE FROM sessions
                WHERE status IN ('inactive', 'archived')
                  AND last_activity < ?
                """,
                (cutoff.isoformat(),),
            )
            count = cursor.rowcount
            await db.commit()

            if count > 0:
                logger.info(f"Permanently deleted {count} old inactive session(s)")

            return count

    async def has_other_active_tabs(
        self,
        base_url: str,
        current_tab_id: str,
        max_age_minutes: int = 30
    ) -> bool:
        """
        Check if other tabs have active sessions for this URL.

        Returns True if there are active sessions for the same base_url
        from different tabs within the time window.
        """
        await self.initialize()

        cutoff = datetime.now() - timedelta(minutes=max_age_minutes)

        async with aiosqlite.connect(self.db_path) as db:
            async with db.execute(
                """
                SELECT COUNT(*) FROM sessions
                WHERE base_url = ?
                  AND tab_id != ?
                  AND status = 'active'
                  AND last_activity > ?
                  AND sdk_session_id IS NOT NULL
                """,
                (base_url, current_tab_id, cutoff.isoformat())
            ) as cursor:
                count = await cursor.fetchone()
                return count[0] > 0 if count else False

    async def find_tab_session(
        self,
        tab_id: str,
        max_age_minutes: int = 30
    ) -> Optional[Dict[str, Any]]:
        """
        Find most recent session for a specific tab.

        Returns the most recently active session for this specific tab
        within the time window. Used for reconnect scenarios where we want
        to resume the same tab's previous session.
        """
        await self.initialize()

        cutoff = datetime.now() - timedelta(minutes=max_age_minutes)

        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                """
                SELECT * FROM sessions
                WHERE tab_id = ?
                  AND status IN ('active', 'inactive')
                  AND last_activity > ?
                  AND sdk_session_id IS NOT NULL
                ORDER BY last_activity DESC
                LIMIT 1
                """,
                (tab_id, cutoff.isoformat())
            ) as cursor:
                row = await cursor.fetchone()
                return dict(row) if row else None

    async def find_resumable_session(
        self,
        base_url: str,
        max_age_minutes: int = 30
    ) -> Optional[Dict[str, Any]]:
        """
        Find most recent session for URL within time window (any tab).

        Returns the most recently active session that matches the base_url
        and is within the time window, regardless of which tab it was from.
        Includes both active and inactive sessions (disconnected but resumable).
        """
        await self.initialize()

        cutoff = datetime.now() - timedelta(minutes=max_age_minutes)

        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                """
                SELECT * FROM sessions
                WHERE base_url = ?
                  AND status IN ('active', 'inactive')
                  AND last_activity > ?
                  AND sdk_session_id IS NOT NULL
                ORDER BY last_activity DESC
                LIMIT 1
                """,
                (base_url, cutoff.isoformat())
            ) as cursor:
                row = await cursor.fetchone()
                return dict(row) if row else None
