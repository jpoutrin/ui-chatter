"""Read-only access to Claude Code's local session storage."""

import json
from pathlib import Path
from typing import List, Optional, Dict, Any


class ClaudeMessage:
    """Represents a message from Claude Code session."""

    def __init__(self, role: str, content: Any, timestamp: str, uuid: str):
        self.role = role
        self.content = content
        self.timestamp = timestamp
        self.uuid = uuid


class SessionRepository:
    """
    Read Claude Code's session files from ~/.claude/

    Structure:
        ~/.claude/projects/{project-hash}/
            ├── sessions-index.json
            └── {session-id}.jsonl
    """

    def __init__(self, project_path: str):
        self.project_path = project_path
        # Claude Code encodes project paths by replacing / with -
        # and removing leading /
        self.project_hash = project_path.lstrip('/').replace('/', '-')
        self.sessions_dir = Path.home() / '.claude' / 'projects' / self.project_hash

    def get_session_file_path(self, session_id: str) -> Path:
        """Get path to session JSONL file."""
        return self.sessions_dir / f"{session_id}.jsonl"

    def session_exists(self, session_id: str) -> bool:
        """Check if Claude Code session file exists."""
        return self.get_session_file_path(session_id).exists()

    def get_messages(self, session_id: str) -> List[ClaudeMessage]:
        """
        Read conversation messages from Claude Code session.

        Returns only user/assistant messages, filters out system events.
        """
        session_file = self.get_session_file_path(session_id)

        if not session_file.exists():
            return []

        messages = []
        with open(session_file) as f:
            for line in f:
                if not line.strip():
                    continue

                try:
                    event = json.loads(line)

                    # Only parse user/assistant messages
                    if event.get('type') not in ('user', 'assistant'):
                        continue

                    msg_data = event.get('message', {})
                    messages.append(ClaudeMessage(
                        role=msg_data.get('role'),
                        content=msg_data.get('content'),
                        timestamp=event.get('timestamp'),
                        uuid=event.get('uuid')
                    ))
                except json.JSONDecodeError:
                    continue

        return messages

    def get_session_index(self) -> List[Dict[str, Any]]:
        """Read sessions index for this project."""
        index_file = self.sessions_dir / 'sessions-index.json'

        if not index_file.exists():
            return []

        try:
            data = json.loads(index_file.read_text())
            return data.get('entries', [])
        except (json.JSONDecodeError, FileNotFoundError):
            return []

    def get_session_metadata(self, session_id: str) -> Optional[Dict[str, Any]]:
        """Get session metadata from index."""
        for entry in self.get_session_index():
            if entry.get('sessionId') == session_id:
                return entry
        return None

    def get_message_count(self, session_id: str) -> int:
        """Get message count from session file."""
        return len(self.get_messages(session_id))
