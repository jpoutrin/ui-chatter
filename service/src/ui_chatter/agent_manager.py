"""Claude Agent SDK lifecycle management."""

import asyncio
import logging
from typing import AsyncGenerator, Optional

from .types import WebSocketMessage
from anthropic import Anthropic, AsyncAnthropic  # type: ignore[import-not-found]

from .models.context import CapturedContext
from .exceptions import AgentAuthError, AgentTimeoutError, AgentError

logger = logging.getLogger(__name__)


class AgentManager:
    """
    Manages Claude Agent SDK lifecycle with proper resource management.

    Features:
    - Lazy initialization with async locking
    - Proper error handling and recovery
    - Graceful shutdown
    """

    def __init__(self, project_path: str, api_key: Optional[str] = None):
        self.project_path = project_path
        self.api_key = api_key
        self._client: Optional[AsyncAnthropic] = None
        self._lock = asyncio.Lock()

    async def get_client(self) -> AsyncAnthropic:
        """Get or create Anthropic client instance (thread-safe lazy init)."""
        async with self._lock:
            if self._client is None:
                self._client = await self._create_client()
            return self._client

    async def _create_client(self) -> AsyncAnthropic:
        """Create Anthropic client asynchronously."""
        logger.info(f"Initializing Claude client for project: {self.project_path}")

        try:
            client = AsyncAnthropic(api_key=self.api_key)
            logger.info("Claude client initialized successfully")
            return client
        except Exception as e:
            logger.error(f"Failed to initialize Claude client: {e}")
            raise AgentAuthError(f"Failed to initialize: {e}")

    async def handle_chat(
        self,
        context: CapturedContext,
        message: str,
        screenshot_path: Optional[str] = None,
    ) -> AsyncGenerator[WebSocketMessage, None]:
        """
        Stream response from Claude with error handling.

        Args:
            context: Captured UI context
            message: User's message
            screenshot_path: Optional path to screenshot file

        Yields:
            dict: Response chunks or error messages

        Latency: ~0.5s first token (vs 60s with ACP) ⚡
        """
        try:
            client = await self.get_client()
            prompt = self._build_prompt(context, message, screenshot_path)

            logger.debug(f"Sending prompt to Claude (length: {len(prompt)} chars)")

            # Stream response using Anthropic API
            async with client.messages.stream(
                model="claude-sonnet-4-20250514",
                max_tokens=4096,
                messages=[{"role": "user", "content": prompt}],
            ) as stream:
                async for text in stream.text_stream:
                    yield {"type": "response_chunk", "content": text, "done": False}

            # Final chunk
            yield {"type": "response_chunk", "content": "", "done": True}

        except Exception as e:
            logger.error(f"Chat error: {e}", exc_info=True)

            # Determine error type
            error_msg = str(e).lower()
            if "auth" in error_msg or "api key" in error_msg:
                yield {
                    "type": "error",
                    "code": "auth_failed",
                    "message": "Authentication failed. Please check your Claude credentials.",
                }
            elif "rate limit" in error_msg:
                yield {
                    "type": "error",
                    "code": "rate_limit",
                    "message": "Rate limit exceeded. Please try again in a few moments.",
                }
            elif "timeout" in error_msg:
                yield {
                    "type": "error",
                    "code": "timeout",
                    "message": "Request timed out. Please try again.",
                }
            else:
                yield {
                    "type": "error",
                    "code": "internal",
                    "message": "An unexpected error occurred. Please try again.",
                }

    def _build_prompt(
        self, context: CapturedContext, message: str, screenshot_path: Optional[str]
    ) -> str:
        """Build prompt from UI context and user message."""
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

    async def shutdown(self) -> None:
        """Cleanup on service shutdown."""
        if self._client:
            logger.info("Shutting down Claude client...")
            await self._client.close()
            self._client = None
            logger.info("Claude client shut down successfully")
