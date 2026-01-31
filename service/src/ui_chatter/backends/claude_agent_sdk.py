"""Claude Agent SDK backend - uses subscription auth from ~/.claude/config."""

import asyncio
import logging
import time
import uuid
from typing import AsyncGenerator, Optional

from claude_agent_sdk import query, ClaudeAgentOptions

from .base import AgentBackend
from ..models.context import CapturedContext
from ..models.messages import (
    ToolActivity, ToolActivityStatus,
    StreamControl, StreamControlAction
)

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
        resume_session_id: Optional[str] = None,  # For explicit resume
        **kwargs
    ):
        super().__init__(project_path)
        self.permission_mode = permission_mode
        self.slash_commands = []  # Captured from SDK init message
        self.allowed_tools = [
            "Read", "Write", "Edit", "Bash", "Glob", "Grep"
        ]

        # If resuming an existing session, set it
        if resume_session_id:
            self.set_sdk_session_id(resume_session_id)

    async def handle_chat(
        self,
        context: CapturedContext,
        message: str,
        screenshot_path: Optional[str] = None,
        cancel_event: Optional[asyncio.Event] = None,
    ) -> AsyncGenerator[dict, None]:
        """
        Stream response using Claude Agent SDK with multi-channel protocol.

        Args:
            context: Captured UI context
            message: User's message
            screenshot_path: Optional path to screenshot file
            cancel_event: Optional event to signal cancellation

        Yields:
            dict: Multi-channel messages (response_chunk, tool_activity, stream_control)
        """
        stream_id = str(uuid.uuid4())
        start_time = time.time()
        tool_count = 0
        response_completed = False  # Track if we've sent the final response

        logger.info(f"[AGENT SDK] handle_chat called with message: {message[:100]}, stream_id: {stream_id}")
        try:
            # Signal stream start
            yield StreamControl(
                action=StreamControlAction.STARTED,
                stream_id=stream_id
            ).model_dump()
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
            # Check if we have an established session to resume
            if self.has_established_session:
                logger.info(f"[AGENT SDK] Resuming session: {self.sdk_session_id}")
                options = ClaudeAgentOptions(
                    resume=self.sdk_session_id,
                    allowed_tools=self.allowed_tools,
                    permission_mode=self.permission_mode,
                    cwd=self.project_path,
                    stderr=lambda msg: logger.error(f"[SDK STDERR] {msg}"),
                )
            else:
                logger.info(f"[AGENT SDK] Creating new session (no resume)")
                options = ClaudeAgentOptions(
                    allowed_tools=self.allowed_tools,
                    permission_mode=self.permission_mode,
                    cwd=self.project_path,
                    stderr=lambda msg: logger.error(f"[SDK STDERR] {msg}"),
                )

            async for msg in query(prompt=prompt, options=options):
                # Check for cancellation
                if cancel_event and cancel_event.is_set():
                    logger.info(f"[AGENT SDK] Stream {stream_id} cancelled by user")
                    yield StreamControl(
                        action=StreamControlAction.CANCELLED,
                        stream_id=stream_id,
                        reason="user_request"
                    ).model_dump()
                    return

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
                    duration_ms = int((time.time() - start_time) * 1000)

                    if is_debug():
                        logger.debug(f"CLAUDE AGENT SDK: Received final message (done=True), duration: {duration_ms}ms")
                        logger.debug(f"CLAUDE AGENT SDK: ResultMessage.result = {getattr(msg, 'result', 'N/A')}")
                        logger.debug(f"CLAUDE AGENT SDK: ResultMessage.is_error = {getattr(msg, 'is_error', False)}")
                        logger.debug(f"CLAUDE AGENT SDK: ResultMessage.subtype = {getattr(msg, 'subtype', 'N/A')}")

                    # Check if execution failed
                    if getattr(msg, 'is_error', False):
                        error_subtype = getattr(msg, 'subtype', 'unknown_error')
                        logger.error(f"[AGENT SDK] Execution failed with subtype: {error_subtype}")

                        # Send error to client
                        yield {
                            "type": "error",
                            "code": "execution_failed",
                            "message": f"Claude encountered an error while processing your request. This may be due to working directory permissions or tool execution issues."
                        }
                        return  # Don't mark as successfully completed

                    response_completed = True  # Mark response as successfully completed

                    # NOTE: Don't send result_text here - it was already sent via AssistantMessage chunks
                    # Sending it again would cause message duplication in the UI

                    yield {"type": "response_chunk", "content": "", "done": True}

                    # Emit completion control message
                    yield StreamControl(
                        action=StreamControlAction.COMPLETED,
                        stream_id=stream_id,
                        metadata={
                            "duration_ms": duration_ms,
                            "tools_used": tool_count
                        }
                    ).model_dump()

                elif msg_type == "AssistantMessage":
                    # Process content blocks (text and tool use)
                    for block in msg.content:
                        block_type = block.__class__.__name__

                        if block_type == "TextBlock":
                            # Yield text content
                            logger.debug(f"[AGENT SDK] Yielding text chunk: {len(block.text)} chars")

                            if is_debug() and block.text:
                                logger.debug(f"CLAUDE AGENT SDK OUTPUT CHUNK: {block.text[:100]}{'...' if len(block.text) > 100 else ''}")

                            yield {
                                "type": "response_chunk",
                                "content": block.text,
                                "done": False
                            }

                        elif block_type == "ToolUseBlock":
                            # NEW: Track tool execution instead of discarding
                            tool_count += 1
                            tool_id = block.id
                            tool_name = block.name

                            logger.info(f"[AGENT SDK] Tool execution started: {tool_name} (id: {tool_id})")

                            yield ToolActivity(
                                tool_id=tool_id,
                                tool_name=tool_name,
                                status=ToolActivityStatus.EXECUTING,
                                input_summary=self._summarize_tool_input(tool_name, block.input),
                            ).model_dump()

                elif msg_type == "ToolResultMessage":
                    # Track tool completion
                    tool_id = msg.tool_use_id if hasattr(msg, "tool_use_id") else "unknown"
                    is_error = msg.is_error if hasattr(msg, "is_error") else False

                    logger.info(f"[AGENT SDK] Tool execution completed: {tool_id} (error: {is_error})")

                    yield ToolActivity(
                        tool_id=tool_id,
                        tool_name="",  # SDK doesn't provide tool name in result
                        status=ToolActivityStatus.FAILED if is_error else ToolActivityStatus.COMPLETED,
                        output_summary=self._summarize_tool_output(msg.content) if hasattr(msg, "content") else None,
                    ).model_dump()

                elif msg_type == "SystemMessage":
                    # Capture session ID and slash_commands from init message (first message)
                    if hasattr(msg, 'subtype') and msg.subtype == 'init':
                        if hasattr(msg, 'data') and isinstance(msg.data, dict):
                            sdk_session_id = msg.data.get('session_id')
                            if sdk_session_id:
                                # Only set if we don't already have a session
                                if not self.has_established_session:
                                    logger.info(f"[AGENT SDK] Session established: {sdk_session_id}")
                                    self.set_sdk_session_id(sdk_session_id)

                                    # Notify session manager to persist this ID
                                    yield {
                                        "type": "session_established",
                                        "sdk_session_id": sdk_session_id
                                    }
                                else:
                                    # Verify it matches our existing session
                                    if sdk_session_id != self.sdk_session_id:
                                        logger.warning(
                                            f"[AGENT SDK] SDK returned different session ID! "
                                            f"Expected: {self.sdk_session_id}, Got: {sdk_session_id}"
                                        )

                            # Capture slash_commands from init message
                            slash_commands = msg.data.get('slash_commands', [])
                            if slash_commands:
                                logger.info(f"[AGENT SDK] Captured {len(slash_commands)} slash commands from SDK")
                                self.slash_commands = slash_commands
                            else:
                                logger.debug("[AGENT SDK] No slash_commands in init message, will use filesystem discovery")
                    # SystemMessage doesn't yield anything to the client (except session_established above)

        except asyncio.CancelledError:
            logger.info(f"[AGENT SDK] Stream {stream_id} cancelled via asyncio")
            yield StreamControl(
                action=StreamControlAction.CANCELLED,
                stream_id=stream_id,
                reason="task_cancelled"
            ).model_dump()

        except Exception as e:
            # If response was already sent successfully, this is likely a cleanup error
            if response_completed:
                logger.warning(f"[AGENT SDK] Post-response cleanup error (non-critical): {e}")
                logger.warning(f"[AGENT SDK] This error occurred after the response was successfully sent")
                logger.debug(f"[AGENT SDK] Cleanup error details: {str(e)}", exc_info=True)
                # Don't send error to client - response was successful
                return

            # Response was not completed - this is a real error
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

    def _summarize_tool_input(self, tool_name: str, input_dict: dict) -> str:
        """
        Create human-readable summary of tool input.

        Args:
            tool_name: Name of the tool being executed
            input_dict: Tool input parameters

        Returns:
            Abbreviated summary string
        """
        if tool_name == "Read":
            return f"Reading {input_dict.get('file_path', 'file')}"
        elif tool_name == "Write":
            return f"Writing {input_dict.get('file_path', 'file')}"
        elif tool_name == "Edit":
            return f"Editing {input_dict.get('file_path', 'file')}"
        elif tool_name == "Bash":
            cmd = input_dict.get('command', '')
            return f"Running: {cmd[:50]}{'...' if len(cmd) > 50 else ''}"
        elif tool_name == "Grep":
            return f"Searching for \"{input_dict.get('pattern', '')}\""
        elif tool_name == "Glob":
            return f"Finding files: {input_dict.get('pattern', '*')}"
        else:
            return f"{tool_name} operation"

    def _summarize_tool_output(self, content) -> Optional[str]:
        """
        Create abbreviated summary of tool output.

        Args:
            content: Tool result content (may be string or list of blocks)

        Returns:
            Abbreviated output summary or None
        """
        if not content:
            return None

        # Handle string content
        if isinstance(content, str):
            if len(content) > 100:
                return content[:100] + "..."
            return content

        # Handle list of content blocks
        if isinstance(content, list):
            text_parts = []
            for block in content:
                if hasattr(block, 'text'):
                    text = block.text
                    if len(text) > 100:
                        text_parts.append(text[:100] + "...")
                    else:
                        text_parts.append(text)

            return " ".join(text_parts) if text_parts else None

        return None

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

    def get_slash_commands(self) -> list[str]:
        """
        Return slash commands captured from SDK init message.

        This is backend-specific - not part of AgentBackend ABC.
        CommandDiscovery uses duck typing to check availability.

        Returns:
            List of slash command names (e.g., ['/compact', '/clear', '/commit'])
        """
        return self.slash_commands

    async def shutdown(self) -> None:
        """Cleanup resources."""
        # SDK handles cleanup automatically
        logger.info("Shutting down Claude Agent SDK backend (no cleanup needed)")
