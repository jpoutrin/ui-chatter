"""Anthropic SDK backend - uses direct API calls with API key."""

import asyncio
import logging
from typing import AsyncGenerator, Optional
from anthropic import AsyncAnthropic

from .base import AgentBackend
from ..models.context import CapturedContext
from ..exceptions import AgentAuthError

logger = logging.getLogger(__name__)


def is_debug() -> bool:
    """Check if debug logging is enabled."""
    return logger.isEnabledFor(logging.DEBUG)


class AnthropicSDKBackend(AgentBackend):
    """
    Backend using Anthropic Python SDK for direct API calls.

    Requires: ANTHROPIC_API_KEY from console.anthropic.com
    Latency: ~0.5s first token
    """

    def __init__(self, project_path: str, api_key: Optional[str] = None, **kwargs):
        super().__init__(project_path)
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
        logger.info(f"Initializing Anthropic SDK client for project: {self.project_path}")

        try:
            client = AsyncAnthropic(api_key=self.api_key)
            logger.info("Anthropic SDK client initialized successfully")
            return client
        except Exception as e:
            logger.error(f"Failed to initialize Anthropic client: {e}")
            raise AgentAuthError(f"Failed to initialize: {e}")

    async def handle_chat(
        self,
        context: CapturedContext,
        message: str,
        is_first_message: bool = False,
        screenshot_path: Optional[str] = None,
    ) -> AsyncGenerator[dict, None]:
        """
        Stream response from Claude using Anthropic SDK.

        Note: Anthropic SDK doesn't have built-in conversation management,
        so is_first_message is ignored. Each request is independent.

        Args:
            context: Captured UI context
            message: User's message
            is_first_message: Ignored for Anthropic SDK
            screenshot_path: Optional path to screenshot file

        Yields:
            dict: Response chunks or error messages
        """
        try:
            client = await self.get_client()
            prompt = self._build_prompt(context, message, screenshot_path)

            logger.debug(f"Sending prompt to Claude (length: {len(prompt)} chars)")

            # Debug logging: show input prompt
            if is_debug():
                logger.debug("=" * 80)
                logger.debug("ANTHROPIC SDK INPUT - USER PROMPT:")
                logger.debug("-" * 80)
                logger.debug(prompt)
                logger.debug("=" * 80)

            # Stream response using Anthropic API
            async with client.messages.stream(
                model="claude-sonnet-4-20250514",
                max_tokens=4096,
                messages=[{"role": "user", "content": prompt}],
            ) as stream:
                async for text in stream.text_stream:
                    # Debug logging: show response chunks
                    if is_debug() and text:
                        logger.debug(f"ANTHROPIC SDK OUTPUT CHUNK: {text[:100]}{'...' if len(text) > 100 else ''}")

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

    async def shutdown(self) -> None:
        """Cleanup on service shutdown."""
        if self._client:
            logger.info("Shutting down Anthropic SDK client...")
            await self._client.close()
            self._client = None
            logger.info("Anthropic SDK client shut down successfully")
