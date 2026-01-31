"""Abstract base class for agent backends."""

import asyncio
import json
from abc import ABC, abstractmethod
from enum import Enum
from typing import AsyncGenerator, Optional

from ..models.context import CapturedContext


class SessionState(Enum):
    """Backend session state."""
    NOT_STARTED = "not_started"      # No SDK session yet
    ESTABLISHED = "established"      # SDK session created and active
    ENDED = "ended"                  # Session ended, cannot resume


class AgentBackend(ABC):
    """
    Abstract interface for Claude agent backends.

    Implementations can use different underlying systems:
    - Anthropic SDK (direct API calls)
    - Claude Code CLI (leverage local Claude authentication)
    - Other future backends
    """

    def __init__(self, project_path: str, **kwargs):
        """
        Initialize backend.

        Args:
            project_path: Working directory for the agent
            **kwargs: Backend-specific configuration
        """
        self.project_path = project_path
        self._session_state = SessionState.NOT_STARTED
        self._sdk_session_id: Optional[str] = None

    @property
    def session_state(self) -> SessionState:
        """Get current session state."""
        return self._session_state

    @property
    def sdk_session_id(self) -> Optional[str]:
        """Get SDK session ID if session is established."""
        return self._sdk_session_id if self._session_state == SessionState.ESTABLISHED else None

    @property
    def has_established_session(self) -> bool:
        """Check if backend has an established SDK session."""
        return self._session_state == SessionState.ESTABLISHED and self._sdk_session_id is not None

    def set_sdk_session_id(self, session_id: str) -> None:
        """
        Set SDK session ID when captured from SystemMessage.

        Args:
            session_id: SDK session ID from SystemMessage.data['session_id']
        """
        self._sdk_session_id = session_id
        self._session_state = SessionState.ESTABLISHED

    def reset_session(self) -> None:
        """Reset session state (for creating new conversation)."""
        self._sdk_session_id = None
        self._session_state = SessionState.NOT_STARTED

    @abstractmethod
    async def handle_chat(
        self,
        context: CapturedContext,
        message: str,
        screenshot_path: Optional[str] = None,
        cancel_event: Optional[asyncio.Event] = None,
    ) -> AsyncGenerator[dict, None]:
        """
        Stream response from Claude with error handling.

        NOTE: Removed is_first_message parameter - backends should use
        self.has_established_session to determine resume behavior.

        Args:
            context: Captured UI context from browser
            message: User's message/request
            screenshot_path: Optional path to screenshot file
            cancel_event: Optional event to signal cancellation

        Yields:
            dict: Multi-channel messages (response_chunk, tool_activity, stream_control)
        """
        pass

    @abstractmethod
    async def shutdown(self) -> None:
        """Cleanup resources on service shutdown."""
        pass

    def _build_prompt(
        self,
        context: Optional[CapturedContext],
        message: str,
        screenshot_path: Optional[str],
    ) -> str:
        """
        Build structured prompt with JSON-formatted context.

        Returns a prompt that includes:
        1. Display message (for chat history)
        2. JSON context (for Claude to parse, if provided)
        3. Clear instructions

        The JSON structure allows extracting the user's original message
        when loading chat history, instead of showing the full technical context.
        """
        # If no context provided, just return the message
        if context is None:
            return message

        element = context.element

        # Build context JSON
        context_json = {
            "display_message": message,  # Store user's original message
            "element": {
                "tagName": element.tagName,
                "id": element.id,
                "classList": element.classList,
                "textContent": element.textContent,
                "xpath": element.xpath,
                "cssSelector": element.cssSelector,
            },
            "page": {
                "url": context.page.url if context.page else None,
                "title": context.page.title if context.page else None,
            }
        }

        # Build structured prompt
        prompt_parts = [
            "You are helping modify a web application's code based on UI element feedback.",
            "",
            "CONTEXT (JSON):",
            json.dumps(context_json, indent=2),
            "",
            f"USER REQUEST: {message}",
            "",
            "Please provide a helpful response about how to implement this change.",
        ]

        return "\n".join(prompt_parts)
