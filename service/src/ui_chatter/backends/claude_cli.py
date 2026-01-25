"""Claude Code CLI backend - uses local Claude Code authentication."""

import asyncio
import json
import logging
from typing import AsyncGenerator, Optional

from .base import AgentBackend
from ..models.context import CapturedContext
from ..exceptions import AgentError

logger = logging.getLogger(__name__)


def is_debug() -> bool:
    """Check if debug logging is enabled."""
    return logger.isEnabledFor(logging.DEBUG)


class ClaudeCodeCLIBackend(AgentBackend):
    """
    Backend using Claude Code CLI for requests.

    Benefits:
    - Uses Claude Code's existing OAuth authentication (no API key needed)
    - Leverages user's Claude Code configuration and settings
    - Same model and capabilities as Claude Code terminal

    Requires: Claude Code CLI installed and authenticated
    """

    def __init__(self, project_path: str, session_id: str, permission_mode: str = "bypassPermissions", **kwargs):
        super().__init__(project_path)
        self.claude_session_id = session_id  # Claude CLI session ID
        self.permission_mode = permission_mode
        logger.info(
            f"Initialized Claude Code CLI backend for project: {project_path} "
            f"with session: {session_id}, permission mode: {permission_mode}"
        )

    async def handle_chat(
        self,
        context: CapturedContext,
        message: str,
        is_first_message: bool = False,
        screenshot_path: Optional[str] = None,
    ) -> AsyncGenerator[dict, None]:
        """
        Stream response from Claude using Claude Code CLI.

        Uses Claude CLI conversation management:
        - First message: `claude -p -c --session-id <uuid>` (create session)
        - Subsequent: `claude -p --resume <uuid>` (continue session)

        Args:
            context: Captured UI context
            message: User's message
            is_first_message: True if this is the first message in the session
            screenshot_path: Optional path to screenshot file

        Yields:
            dict: Response chunks or error messages
        """
        try:
            # Build user message (no system prompt needed - CLI manages conversation)
            user_message = self._build_cli_message(context, message, screenshot_path)
            logger.debug(f"Sending message to Claude CLI (length: {len(user_message)} chars)")

            # Build system prompt for first message
            system_prompt = None
            if is_first_message:
                system_prompt = (
                    f"You are helping modify a web application's code based on UI element feedback. "
                    f"The project is located at: {self.project_path}\n\n"
                    f"When the user selects a UI element and makes a request, provide clear, "
                    f"actionable guidance on how to implement the requested change in the codebase."
                )

            # Debug logging: show input prompts
            if is_debug():
                logger.debug("=" * 80)
                logger.debug(f"CLAUDE CLI INPUT ({'FIRST' if is_first_message else 'RESUME'}):")
                logger.debug("-" * 80)
                if system_prompt:
                    logger.debug("SYSTEM PROMPT:")
                    logger.debug(system_prompt)
                    logger.debug("-" * 80)
                logger.debug("USER MESSAGE:")
                logger.debug(user_message)
                logger.debug("=" * 80)

            # Build CLI command based on whether this is first message
            if is_first_message:
                # First message: create new session with system prompt
                cmd = [
                    "claude",
                    "-p",  # Print mode (non-interactive)
                    "--session-id", self.claude_session_id,
                    "--permission-mode", self.permission_mode,
                    "--system-prompt", system_prompt,
                    "--output-format", "stream-json",
                    "--verbose",
                ]
            else:
                # Subsequent messages: resume existing session
                cmd = [
                    "claude",
                    "-p",  # Print mode (non-interactive)
                    "--resume", self.claude_session_id,
                    "--permission-mode", self.permission_mode,
                    "--output-format", "stream-json",
                    "--verbose",
                ]

            # Start subprocess with cwd set to project path
            # Claude CLI uses the current working directory as the project context
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=self.project_path,  # Set working directory to project path
            )

            # Send user message to stdin
            if process.stdin:
                process.stdin.write(user_message.encode())
                await process.stdin.drain()
                process.stdin.close()

            # Track if we got a successful result
            got_success = False
            stderr_lines = []

            # Create task to capture stderr concurrently
            async def capture_stderr():
                """Capture stderr lines as they arrive."""
                if process.stderr:
                    async for line in process.stderr:
                        stderr_line = line.decode().strip()
                        if stderr_line:
                            stderr_lines.append(stderr_line)
                            # Always log stderr in debug mode
                            if is_debug():
                                logger.debug(f"CLAUDE CLI STDERR: {stderr_line}")

            # Start stderr capture in background
            stderr_task = asyncio.create_task(capture_stderr())

            # Stream JSON output line by line
            if process.stdout:
                async for line in process.stdout:
                    if not line.strip():
                        continue

                    # Debug logging: show raw Claude CLI output
                    if is_debug():
                        logger.debug(f"CLAUDE CLI OUTPUT: {line.decode().strip()}")

                    try:
                        data = json.loads(line.decode())

                        # Handle different message types from Claude CLI
                        msg_type = data.get("type")

                        if msg_type == "system":
                            # System init message - log session info
                            session_id = data.get("session_id")
                            if session_id:
                                logger.debug(f"Claude CLI session: {session_id}")

                        elif msg_type == "assistant":
                            # Assistant message with content
                            message_data = data.get("message", {})
                            content_list = message_data.get("content", [])

                            for content_block in content_list:
                                if content_block.get("type") == "text":
                                    text = content_block.get("text", "")
                                    if text:
                                        yield {
                                            "type": "response_chunk",
                                            "content": text,
                                            "done": False,
                                        }

                        elif msg_type == "result":
                            # Final result message
                            subtype = data.get("subtype")
                            if subtype == "success":
                                # Success - yield final chunk
                                got_success = True
                                yield {
                                    "type": "response_chunk",
                                    "content": "",
                                    "done": True,
                                }
                                logger.info(
                                    f"Claude CLI completed in {data.get('duration_ms')}ms"
                                )
                            else:
                                # Error result
                                error_msg = data.get("error", "Unknown error")
                                logger.error(f"Claude CLI error: {error_msg}")
                                yield {
                                    "type": "error",
                                    "code": "cli_error",
                                    "message": f"Claude CLI error: {error_msg}",
                                }

                        elif msg_type == "error":
                            # Error message
                            error_msg = data.get("message", "Unknown error")
                            logger.error(f"Claude CLI error: {error_msg}")
                            yield {
                                "type": "error",
                                "code": "cli_error",
                                "message": error_msg,
                            }

                    except json.JSONDecodeError as e:
                        logger.warning(f"Failed to parse JSON from Claude CLI: {e}")
                        continue

            # Wait for process and stderr capture to complete
            return_code = await process.wait()
            await stderr_task

            # Only treat as error if we didn't get a success result
            if return_code != 0 and not got_success:
                stderr_text = "\n".join(stderr_lines) if stderr_lines else "Unknown error"

                logger.error(
                    f"Claude CLI exited with code {return_code}"
                )
                logger.error("Stderr output:")
                for line in stderr_lines:
                    logger.error(f"  {line}")

                yield {
                    "type": "error",
                    "code": "cli_failed",
                    "message": f"Claude CLI failed: {stderr_text}",
                }
            elif return_code != 0 and got_success:
                # Got successful result but non-zero exit code
                # This can happen with Claude CLI - log as warning not error
                logger.warning(
                    f"Claude CLI completed successfully but exited with code {return_code}"
                )
                if stderr_lines:
                    logger.warning("Stderr output:")
                    for line in stderr_lines:
                        logger.warning(f"  {line}")

        except FileNotFoundError:
            logger.error("Claude CLI not found in PATH")
            yield {
                "type": "error",
                "code": "cli_not_found",
                "message": "Claude Code CLI not found. Please install Claude Code.",
            }

        except Exception as e:
            logger.error(f"Claude CLI error: {e}", exc_info=True)
            yield {
                "type": "error",
                "code": "internal",
                "message": f"An unexpected error occurred: {str(e)}",
            }

    def _build_cli_message(
        self,
        context: CapturedContext,
        message: str,
        screenshot_path: Optional[str],
    ) -> str:
        """
        Build user message for Claude CLI.

        Claude CLI manages conversation history, so we just send the current message
        with UI context.
        """
        element = context.element

        # Build element description
        element_desc = f"<{element.tagName}"
        if element.id:
            element_desc += f' id="{element.id}"'
        if element.classList:
            element_desc += f' class="{" ".join(element.classList)}"'
        element_desc += ">"

        # Build user message
        message_parts = [
            f"The user selected this element: {element_desc}",
        ]

        if element.textContent:
            message_parts.append(f"Text content: {element.textContent}")

        if context.page:
            message_parts.append(f"On page: {context.page.url}")

        message_parts.extend([
            "",
            f"User request: {message}",
        ])

        return "\n".join(message_parts)

    async def shutdown(self) -> None:
        """Cleanup on service shutdown."""
        logger.info("Claude CLI backend shutdown (no resources to clean up)")
