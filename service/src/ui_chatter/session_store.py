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
                await db.execute("""
                    CREATE TABLE IF NOT EXISTS sessions (
                        session_id TEXT PRIMARY KEY,
                        project_path TEXT NOT NULL,
                        backend_type TEXT NOT NULL,
                        permission_mode TEXT,
                        status TEXT NOT NULL DEFAULT 'active',
                        first_message_sent INTEGER NOT NULL DEFAULT 0,
                        created_at TEXT NOT NULL,
                        last_activity TEXT NOT NULL
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

                await db.commit()
                logger.info(f"SessionStore initialized at {self.db_path}")
                self._initialized = True

    async def save_session(
        self,
        session_id: str,
        project_path: str,
        backend_type: str,
        permission_mode: Optional[str] = None,
        created_at: Optional[datetime] = None,
        first_message_sent: bool = False,
        status: str = "active",
    ) -> None:
        """Save or update session metadata."""
        await self.initialize()

        now = datetime.now()
        created_at = created_at or now

        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                """
                INSERT INTO sessions
                    (session_id, project_path, backend_type, permission_mode,
                     status, first_message_sent, created_at, last_activity)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET
                    project_path = excluded.project_path,
                    backend_type = excluded.backend_type,
                    permission_mode = excluded.permission_mode,
                    status = excluded.status,
                    first_message_sent = excluded.first_message_sent,
                    last_activity = excluded.last_activity
                """,
                (
                    session_id,
                    project_path,
                    backend_type,
                    permission_mode,
                    status,
                    1 if first_message_sent else 0,
                    created_at.isoformat(),
                    now.isoformat(),
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

    async def mark_first_message_sent(self, session_id: str) -> None:
        """Mark that first message has been sent."""
        await self.initialize()

        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                """
                UPDATE sessions
                SET first_message_sent = 1, last_activity = ?
                WHERE session_id = ?
                """,
                (datetime.now().isoformat(), session_id),
            )
            await db.commit()

    async def delete_session(self, session_id: str) -> None:
        """Delete session metadata."""
        await self.initialize()

        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                "DELETE FROM sessions WHERE session_id = ?", (session_id,)
            )
            await db.commit()

    async def get_active_sessions(self) -> List[Dict[str, Any]]:
        """Get all active sessions for recovery."""
        await self.initialize()

        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT * FROM sessions WHERE status = 'active' ORDER BY last_activity DESC"
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
