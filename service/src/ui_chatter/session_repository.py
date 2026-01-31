"""Read-only access to Claude Code's local session storage."""

import json
import logging
from pathlib import Path
from typing import List, Optional, Dict, Any

logger = logging.getLogger(__name__)


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
        # Claude Code encodes project paths by replacing / and . with -
        # and adding a leading dash
        self.project_hash = '-' + project_path.lstrip('/').replace('/', '-').replace('.', '-')
        self.sessions_dir = Path.home() / '.claude' / 'projects' / self.project_hash
        logger.info(f"SessionRepository initialized with project_hash: {self.project_hash}")
        logger.info(f"Session directory: {self.sessions_dir}")

    def _extract_display_content(self, content: Any) -> str:
        """
        Extract display-friendly content from message.

        Handles:
        - String content (legacy format)
        - Array content (Claude API format)
        - JSON-structured content (new format)

        For new format messages, extracts the display_message from the JSON context.
        For old format messages, returns content as-is (backward compatible).
        """
        # Handle array format (Claude API)
        if isinstance(content, list):
            text_blocks = [block.get('text', '') for block in content if block.get('type') == 'text']
            content = '\n'.join(text_blocks)

        # Handle string format
        if isinstance(content, str):
            # Try to parse JSON-structured prompt
            try:
                # Look for "CONTEXT (JSON):" marker
                if "CONTEXT (JSON):" in content:
                    lines = content.split('\n')
                    # Find the JSON block
                    json_start = None
                    for i, line in enumerate(lines):
                        if line.strip() == "CONTEXT (JSON):":
                            json_start = i + 1
                            break

                    if json_start:
                        # Extract JSON (from json_start until next blank line)
                        json_lines = []
                        for line in lines[json_start:]:
                            if line.strip() == "":
                                break
                            json_lines.append(line)

                        # Parse JSON
                        context_json = json.loads('\n'.join(json_lines))
                        # Return display message
                        display_msg = context_json.get('display_message', content)
                        return str(display_msg)
            except Exception:
                # If parsing fails, fall back to returning content as-is
                pass

        # Fallback: return as-is
        return str(content)

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
        For user messages, extracts display-friendly content (user's original message)
        instead of the full technical context.
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
                    raw_content = msg_data.get('content')

                    # Extract display-friendly content for user messages
                    if msg_data.get('role') == 'user':
                        display_content = self._extract_display_content(raw_content)
                    else:
                        # For assistant messages, keep as-is
                        display_content = raw_content

                    messages.append(ClaudeMessage(
                        role=msg_data.get('role'),
                        content=display_content,
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
            entries = data.get('entries', [])
            return list(entries) if isinstance(entries, list) else []
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
