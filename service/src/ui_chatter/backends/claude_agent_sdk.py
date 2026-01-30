"""Claude Agent SDK backend - uses subscription auth from ~/.claude/config."""

import logging
from typing import AsyncGenerator, Optional

from claude_agent_sdk import query, ClaudeAgentOptions

from .base import AgentBackend
from ..models.context import CapturedContext

logger = logging.getLogger(__name__)


def is_debug() -> bool:
    """Check if debug logging is enabled."""
    return logger.isEnabledFor(logging.DEBUG)


class ClaudeAgentSDKBackend(AgentBackend):
    """
    Backend using Claude Agent SDK with subscription authentication.

    Authentication: Auto-detects credentials from ~/.claude/config (no API key needed)
    Latency: <1s first token (in-process)
    Cost: $0 (uses Claude Max subscription)
    """

    def __init__(
        self,
        project_path: str,
        permission_mode: str = "bypassPermissions",
        **kwargs
    ):
        super().__init__(project_path)
        self.permission_mode = permission_mode
        self.allowed_tools = [
            "Read", "Write", "Edit", "Bash", "Glob", "Grep"
        ]

    async def handle_chat(
        self,
        context: CapturedContext,
        message: str,
        is_first_message: bool = False,
        screenshot_path: Optional[str] = None,
    ) -> AsyncGenerator[dict, None]:
        """
        Stream response using Claude Agent SDK.

        Args:
            context: Captured UI context
            message: User's message
            is_first_message: Ignored for Agent SDK (stateless)
            screenshot_path: Optional path to screenshot file

        Yields:
            dict: Response chunks or error messages
        """
        logger.info(f"[AGENT SDK] handle_chat called with message: {message[:100]}")
        try:
            # Build prompt with context
            prompt = self._build_prompt(context, message, screenshot_path)

            logger.info(f"[AGENT SDK] Sending prompt to Claude Agent SDK (length: {len(prompt)} chars)")
            logger.info(f"[AGENT SDK] Permission mode: {self.permission_mode}")
            logger.info(f"[AGENT SDK] Allowed tools: {self.allowed_tools}")

            # Debug logging: show input prompt
            if is_debug():
                logger.debug("=" * 80)
                logger.debug("CLAUDE AGENT SDK INPUT - USER PROMPT:")
                logger.debug("-" * 80)
                logger.debug(prompt)
                logger.debug("=" * 80)

            # Stream from SDK (NO api_key needed - auto-detects from ~/.claude/config)
            logger.info("[AGENT SDK] Calling query()...")
            async for msg in query(
                prompt=prompt,
                options=ClaudeAgentOptions(
                    allowed_tools=self.allowed_tools,
                    permission_mode=self.permission_mode,
                )
            ):
                logger.info(f"[AGENT SDK] Received message from SDK: {type(msg)}")

                # Debug: inspect message class name
                if is_debug():
                    logger.debug(f"[AGENT SDK] Message class: {type(msg).__name__}")
                    logger.debug(f"[AGENT SDK] Message attributes: {dir(msg)}")
                    if hasattr(msg, "content"):
                        logger.debug(f"[AGENT SDK] Message content: {msg.content}")

                # Handle different message types by class name
                msg_type = type(msg).__name__

                if msg_type == "ResultMessage":
                    # Final message with result
                    if is_debug():
                        logger.debug("CLAUDE AGENT SDK: Received final message (done=True)")
                    yield {"type": "response_chunk", "content": "", "done": True}

                elif msg_type == "AssistantMessage":
                    # Extract text from content blocks
                    content = self._extract_text_content(msg)

                    # Yield chunk even if empty (maintains streaming flow)
                    # Empty chunks can occur when Claude uses tools without text
                    logger.debug(f"[AGENT SDK] Yielding assistant chunk: {len(content)} chars")

                    # Debug logging: show response chunks
                    if is_debug() and content:
                        logger.debug(f"CLAUDE AGENT SDK OUTPUT CHUNK: {content[:100]}{'...' if len(content) > 100 else ''}")

                    yield {
                        "type": "response_chunk",
                        "content": content,
                        "done": False
                    }

        except Exception as e:
            logger.error(f"[AGENT SDK] Chat error: {e}", exc_info=True)
            logger.error(f"[AGENT SDK] Error type: {type(e).__name__}")
            logger.error(f"[AGENT SDK] Error details: {str(e)}")

            # Map errors to user-friendly messages
            error_code = self._classify_error(e)
            error_message = self._get_error_message(error_code, e)

            logger.error(f"[AGENT SDK] Classified as: {error_code}")
            logger.error(f"[AGENT SDK] User message: {error_message}")

            yield {
                "type": "error",
                "code": error_code,
                "message": error_message
            }

    def _extract_text_content(self, message) -> str:
        """
        Extract text from message content blocks.

        According to SDK docs, messages have a .content list containing
        various block types. Only TextBlock objects have displayable text.

        Args:
            message: SDK Message object with .content attribute

        Returns:
            Concatenated text from all TextBlock objects
        """
        if not hasattr(message, "content"):
            logger.warning("[AGENT SDK] Message has no content attribute")
            return ""

        text_parts = []
        for i, block in enumerate(message.content):
            # Get block type using __class__.__name__
            block_type = block.__class__.__name__

            logger.debug(f"[AGENT SDK] Block {i}: type={block_type}, has_text={hasattr(block, 'text')}")

            if block_type == "TextBlock":
                # TextBlock has .text attribute (guaranteed by SDK)
                text_parts.append(block.text)
                logger.debug(f"[AGENT SDK] Extracted {len(block.text)} chars from TextBlock")

            elif block_type == "ToolUseBlock":
                # ToolUseBlock represents Claude calling a tool
                # Has .name and .input, but no displayable text
                logger.debug(f"[AGENT SDK] Skipping ToolUseBlock (tool: {block.name})")
                continue

            elif hasattr(block, "text"):
                # Fallback for unknown block types with text attribute
                text_parts.append(block.text)
                logger.warning(f"[AGENT SDK] Unknown block type with text: {block_type}")

        result = "".join(text_parts)
        logger.debug(f"[AGENT SDK] Total extracted: {len(result)} chars")
        return result

    def _classify_error(self, error: Exception) -> str:
        """Classify error type for appropriate handling."""
        error_str = str(error).lower()

        if "auth" in error_str or "credential" in error_str:
            return "auth_failed"
        elif "permission" in error_str:
            return "permission_denied"
        elif "rate" in error_str or "limit" in error_str:
            return "rate_limit"
        elif "timeout" in error_str:
            return "timeout"
        else:
            return "internal"

    def _get_error_message(self, code: str, error: Exception) -> str:
        """Get user-friendly error message."""
        messages = {
            "auth_failed": "Authentication failed. Please run 'claude login' in terminal to authenticate.",
            "permission_denied": "Permission denied. Try switching to bypass mode in session settings.",
            "rate_limit": "Rate limit exceeded. Please try again in a few moments.",
            "timeout": "Request timed out. Please try again.",
            "internal": f"An unexpected error occurred: {str(error)}"
        }
        return messages.get(code, str(error))

    async def shutdown(self) -> None:
        """Cleanup resources."""
        # SDK handles cleanup automatically
        logger.info("Shutting down Claude Agent SDK backend (no cleanup needed)")
