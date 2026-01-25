"""Abstract base class for agent backends."""

from abc import ABC, abstractmethod
from typing import AsyncGenerator, Optional

from ..models.context import CapturedContext


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

    @abstractmethod
    async def handle_chat(
        self,
        context: CapturedContext,
        message: str,
        is_first_message: bool = False,
        screenshot_path: Optional[str] = None,
    ) -> AsyncGenerator[dict, None]:
        """
        Stream response from Claude with error handling.

        Args:
            context: Captured UI context from browser
            message: User's message/request
            is_first_message: True if this is the first message in the session (for backends that manage history)
            screenshot_path: Optional path to screenshot file

        Yields:
            dict: Response chunks with structure:
                - {"type": "response_chunk", "content": str, "done": bool}
                - {"type": "error", "code": str, "message": str}
        """
        pass

    @abstractmethod
    async def shutdown(self) -> None:
        """Cleanup resources on service shutdown."""
        pass

    def _build_prompt(
        self,
        context: CapturedContext,
        message: str,
        screenshot_path: Optional[str],
    ) -> str:
        """
        Build prompt from UI context and user message.

        Shared implementation for backends that don't manage history themselves.
        """
        element = context.element

        # Build element description
        element_desc = f"<{element.tagName}"
        if element.id:
            element_desc += f' id="{element.id}"'
        if element.classList:
            element_desc += f' class="{" ".join(element.classList)}"'
        element_desc += ">"

        # Build full prompt
        prompt_parts = [
            "You are helping modify a web application's code based on UI element feedback.",
            "",
            f"The user selected this element: {element_desc}",
        ]

        if element.textContent:
            prompt_parts.append(f"Text content: {element.textContent}")

        if element.xpath:
            prompt_parts.append(f"XPath: {element.xpath}")

        if element.cssSelector:
            prompt_parts.append(f"CSS Selector: {element.cssSelector}")

        if context.page:
            prompt_parts.append(f"On page: {context.page.url}")

        prompt_parts.extend(
            [
                "",
                f"User request: {message}",
                "",
                "Please provide a helpful response about how to implement this change.",
            ]
        )

        return "\n".join(prompt_parts)
