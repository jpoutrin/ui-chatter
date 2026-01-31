"""Claude Agent SDK backend - uses subscription auth from ~/.claude/config."""

import asyncio
import logging
import time
import uuid
from datetime import datetime
from typing import (
    Any, AsyncGenerator, AsyncIterable, Awaitable, Callable,
    Literal, TypedDict, TypeGuard, cast, TYPE_CHECKING
)
from typing_extensions import NotRequired

from claude_agent_sdk import query, ClaudeAgentOptions
from claude_agent_sdk.types import (
    # Permission types
    PermissionResult, PermissionResultAllow, PermissionResultDeny,
    PermissionMode as SDKPermissionMode, ToolPermissionContext,
    PermissionUpdate, PermissionBehavior,

    # Message types
    Message, UserMessage, AssistantMessage,
    SystemMessage, ResultMessage, StreamEvent,
    AssistantMessageError,

    # Content block types
    ContentBlock, TextBlock, ThinkingBlock,
    ToolUseBlock, ToolResultBlock,

    # Options
    ClaudeAgentOptions,
)

from .base import AgentBackend
from ..models.context import CapturedContext
from ..types import (
    WebSocketMessage,
    ResponseChunkDict, ErrorDict, SessionEstablishedDict,
)
from ..models.messages import (
    PermissionMode,
    ToolActivity, ToolActivityStatus,
    StreamControl, StreamControlAction
)

logger = logging.getLogger(__name__)

# Global cache for slash commands (shared across all backend instances)
_SLASH_COMMANDS_CACHE: list[str] = []
_SLASH_COMMANDS_INITIALIZED = False

# Constants for robustness and clarity
MAX_MESSAGE_LENGTH = 100_000  # 100KB max message length
SDK_QUERY_TIMEOUT = 300  # 5 minutes timeout for SDK query
LOG_TRUNCATE_LENGTH = 100  # Truncate log messages to this length

# SDK Message Type Constants (avoid magic strings)
SDK_MSG_RESULT = "ResultMessage"
SDK_MSG_ASSISTANT = "AssistantMessage"
SDK_MSG_TOOL_RESULT = "ToolResultMessage"
SDK_MSG_SYSTEM = "SystemMessage"
SDK_BLOCK_TEXT = "TextBlock"
SDK_BLOCK_TOOL_USE = "ToolUseBlock"


# ============================================================================
# TypedDict Definitions for Internal Data Structures
# ============================================================================

# Permission request structures
class PendingPermissionRequest(TypedDict):
    """Structure for pending permission requests."""
    event: asyncio.Event
    result: "PermissionResponse | None"


class PermissionResponse(TypedDict):
    """User's response to a permission request."""
    approved: bool
    modified_input: NotRequired[dict[str, Any]]
    answers: NotRequired[dict[str, str]]  # Question key -> answer
    reason: NotRequired[str]


# Error codes for classification
ErrorCode = Literal[
    "auth_failed", "permission_denied", "rate_limit",
    "timeout", "internal", "execution_failed"
]


class ToolApprovalRequest(TypedDict):
    """Tool approval permission request."""
    type: Literal["permission_request"]
    request_id: str
    request_type: Literal["tool_approval"]
    tool_name: str
    input_data: dict[str, Any]
    timeout_seconds: int
    timestamp: str


class AskUserQuestionRequest(TypedDict):
    """AskUserQuestion permission request."""
    type: Literal["permission_request"]
    request_id: str
    request_type: Literal["ask_user_question"]
    questions: list[dict[str, Any]]
    timeout_seconds: int
    timestamp: str


# Tool name types
ToolName = Literal["Read", "Write", "Edit", "Bash", "Grep", "Glob"]
MetaToolName = Literal[
    "AskUserQuestion", "EnterPlanMode", "ExitPlanMode",
    "TaskCreate", "TaskUpdate", "TaskGet", "TaskList", "Skill"
]


# ============================================================================
# TypeGuard Functions for Runtime Type Narrowing
# ============================================================================

def is_text_block(block: ContentBlock) -> TypeGuard[TextBlock]:
    """Type guard for TextBlock."""
    return isinstance(block, TextBlock)


def is_tool_use_block(block: ContentBlock) -> TypeGuard[ToolUseBlock]:
    """Type guard for ToolUseBlock."""
    return isinstance(block, ToolUseBlock)


def is_result_message(msg: Message) -> TypeGuard[ResultMessage]:
    """Type guard for ResultMessage."""
    return isinstance(msg, ResultMessage)


def is_assistant_message(msg: Message) -> TypeGuard[AssistantMessage]:
    """Type guard for AssistantMessage."""
    return isinstance(msg, AssistantMessage)


def is_system_message(msg: Message) -> TypeGuard[SystemMessage]:
    """Type guard for SystemMessage."""
    return isinstance(msg, SystemMessage)


def is_debug() -> bool:
    """Check if debug logging is enabled."""
    return logger.isEnabledFor(logging.DEBUG)


class PermissionRequestManager:
    """Manages pending permission requests from the SDK."""

    def __init__(self) -> None:
        self._pending_requests: dict[str, PendingPermissionRequest] = {}

    def create_request(self) -> tuple[str, asyncio.Event]:
        """Create a new permission request and return (request_id, event)."""
        request_id = str(uuid.uuid4())  # Use UUID to prevent collisions on service restart

        event = asyncio.Event()
        self._pending_requests[request_id] = {"event": event, "result": None}

        return request_id, event

    def resolve_request(self, request_id: str, result: PermissionResponse) -> None:
        """Resolve a pending permission request with user's response."""
        if request_id in self._pending_requests:
            self._pending_requests[request_id]["result"] = result
            self._pending_requests[request_id]["event"].set()

    def cleanup_request(self, request_id: str) -> None:
        """Clean up a permission request after completion."""
        self._pending_requests.pop(request_id, None)


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
        permission_mode: PermissionMode = "bypassPermissions",
        resume_session_id: str | None = None,  # For explicit resume
        ws_send_callback: Callable[[WebSocketMessage], Awaitable[None]] | None = None,  # NEW: WebSocket send callback
        **kwargs: Any
    ) -> None:
        super().__init__(project_path)
        self.permission_mode: PermissionMode = permission_mode
        self.slash_commands: list[str] = []  # Captured from SDK init message
        self.slash_commands_initialized: bool = False  # Track if we've fetched commands
        self.allowed_tools: list[str] = [
            "Read", "Write", "Edit", "Bash", "Glob", "Grep"
        ]
        self.ws_send_callback: Callable[[WebSocketMessage], Awaitable[None]] | None = ws_send_callback
        self.permission_manager: PermissionRequestManager = PermissionRequestManager()

        # If resuming an existing session, set it
        if resume_session_id:
            self.set_sdk_session_id(resume_session_id)

    async def initialize_slash_commands(self) -> None:
        """
        Initialize slash commands by sending a minimal query to get the init message.
        Uses global cache so all backend instances share the same commands.
        """
        global _SLASH_COMMANDS_CACHE, _SLASH_COMMANDS_INITIALIZED

        if _SLASH_COMMANDS_INITIALIZED:
            logger.debug("[AGENT SDK] Slash commands already initialized globally")
            self.slash_commands = _SLASH_COMMANDS_CACHE
            self.slash_commands_initialized = True
            return

        logger.info("[AGENT SDK] Initializing slash commands globally...")

        try:
            # Always create a new session for initialization (don't resume)
            # This ensures we get the init message with slash_commands
            # Include user and project settings to load plugins
            options = ClaudeAgentOptions(
                resume=None,  # Force new session to get init message
                allowed_tools=self.allowed_tools,
                permission_mode=self.permission_mode,
                cwd=self.project_path,
                setting_sources=['user', 'project'],  # Load plugins from user and project directories
                stderr=lambda msg: logger.error(f"[SDK STDERR] {msg}"),
            )

            # Send minimal prompt to get init message with slash commands
            message_count = 0
            async for msg in query(prompt=".", options=options):
                msg_type = type(msg).__name__
                message_count += 1
                logger.debug(f"[AGENT SDK] Init query message #{message_count}: {msg_type}")

                if msg_type == "SystemMessage":
                    logger.debug(f"[AGENT SDK] SystemMessage attributes: {dir(msg)}")
                    if hasattr(msg, 'subtype'):
                        logger.debug(f"[AGENT SDK] SystemMessage subtype: {msg.subtype}")

                        if msg.subtype == 'init':
                            # Log the data to see what's available
                            if hasattr(msg, 'data'):
                                logger.debug(f"[AGENT SDK] Init message data keys: {list(msg.data.keys()) if isinstance(msg.data, dict) else 'not a dict'}")
                                logger.debug(f"[AGENT SDK] Init message data: {msg.data}")

                            # Try to get slash commands from data or as direct attribute
                            slash_cmds = None
                            if hasattr(msg, 'slash_commands'):
                                slash_cmds = msg.slash_commands
                                logger.debug("[AGENT SDK] Found slash_commands as direct attribute")
                            elif hasattr(msg, 'data') and isinstance(msg.data, dict):
                                slash_cmds = msg.data.get('slash_commands')
                                logger.debug(f"[AGENT SDK] Found slash_commands in data: {slash_cmds is not None}")

                            if slash_cmds:
                                # Store in global cache
                                _SLASH_COMMANDS_CACHE.clear()
                                _SLASH_COMMANDS_CACHE.extend(slash_cmds)
                                _SLASH_COMMANDS_INITIALIZED = True

                                # Also store in instance
                                self.slash_commands = slash_cmds
                                self.slash_commands_initialized = True

                                logger.info(f"[AGENT SDK] Initialized {len(slash_cmds)} slash commands globally: {slash_cmds[:5]}...")
                                return  # We got what we need, exit early
                            else:
                                logger.warning("[AGENT SDK] Init message has no slash_commands (checked attribute and data dict)")

            logger.warning(f"[AGENT SDK] Initialization complete but no init message received (processed {message_count} messages)")
            _SLASH_COMMANDS_INITIALIZED = True  # Mark as initialized to prevent retry
            self.slash_commands_initialized = True

        except Exception as e:
            logger.error(f"[AGENT SDK] Failed to initialize slash commands: {e}")
            _SLASH_COMMANDS_INITIALIZED = True  # Don't retry on every call
            self.slash_commands_initialized = True

    async def _create_prompt_stream(
        self,
        prompt_text: str
    ) -> AsyncIterable[dict[str, Any]]:
        """
        Convert a string prompt to an AsyncIterable stream for SDK streaming mode.

        Required when using can_use_tool callback.

        Args:
            prompt_text: The formatted prompt string

        Yields:
            Message dict in SDK streaming format
        """
        yield {
            "type": "user",
            "message": {
                "role": "user",
                "content": prompt_text
            },
            "parent_tool_use_id": None,
        }

    def _validate_message_length(self, message: str) -> None:
        """
        Validate message length to prevent resource exhaustion.

        Args:
            message: User's message

        Raises:
            ValueError: If message exceeds MAX_MESSAGE_LENGTH
        """
        if len(message) > MAX_MESSAGE_LENGTH:
            raise ValueError(
                f"Message too long ({len(message)} chars). "
                f"Maximum allowed: {MAX_MESSAGE_LENGTH} chars"
            )

    def _create_agent_options(self) -> ClaudeAgentOptions:
        """
        Create ClaudeAgentOptions for SDK query (consolidates duplicate logic).

        Returns:
            Configured ClaudeAgentOptions instance
        """
        if self.has_established_session:
            logger.info(f"[AGENT SDK] Resuming session: {self.sdk_session_id}")
            return ClaudeAgentOptions(
                resume=self.sdk_session_id,
                allowed_tools=self.allowed_tools,
                permission_mode=self.permission_mode,
                cwd=self.project_path,
                setting_sources=['user', 'project'],
                stderr=lambda msg: logger.error(f"[SDK STDERR] {msg}"),
                can_use_tool=self._can_use_tool_callback,
            )
        else:
            logger.info("[AGENT SDK] Creating new session (no resume)")
            return ClaudeAgentOptions(
                allowed_tools=self.allowed_tools,
                permission_mode=self.permission_mode,
                cwd=self.project_path,
                setting_sources=['user', 'project'],
                stderr=lambda msg: logger.error(f"[SDK STDERR] {msg}"),
                can_use_tool=self._can_use_tool_callback,
            )

    async def handle_chat(
        self,
        context: CapturedContext | None,
        message: str,
        screenshot_path: str | None = None,
        cancel_event: asyncio.Event | None = None,
        selected_text: str | None = None,
    ) -> AsyncGenerator[WebSocketMessage, None]:
        """
        Stream response using Claude Agent SDK with multi-channel protocol.

        Args:
            context: Captured UI context
            message: User's message
            screenshot_path: Optional path to screenshot file
            cancel_event: Optional event to signal cancellation
            selected_text: Optional selected text from the page

        Yields:
            dict: Multi-channel messages (response_chunk, tool_activity, stream_control)
        """
        stream_id = str(uuid.uuid4())
        start_time = time.time()
        tool_count = 0
        response_completed = False  # Track if we've sent the final response

        logger.info(f"[AGENT SDK] handle_chat called with message: {message[:LOG_TRUNCATE_LENGTH]}, stream_id: {stream_id}")
        try:
            # Validate message length
            self._validate_message_length(message)

            # Signal stream start
            yield StreamControl(
                action=StreamControlAction.STARTED,
                stream_id=stream_id
            ).model_dump()

            # Build prompt with context
            prompt_text = self._build_prompt(context, message, screenshot_path, selected_text)

            logger.info(f"[AGENT SDK] Sending prompt to Claude Agent SDK (length: {len(prompt_text)} chars)")
            logger.info(f"[AGENT SDK] Permission mode: {self.permission_mode}")
            logger.info(f"[AGENT SDK] Allowed tools: {self.allowed_tools}")

            # Debug logging: show input prompt
            if is_debug():
                logger.debug("=" * 80)
                logger.debug("CLAUDE AGENT SDK INPUT - USER PROMPT:")
                logger.debug("-" * 80)
                logger.debug(prompt_text)
                logger.debug("=" * 80)

            # Create agent options (consolidated helper method)
            options = self._create_agent_options()

            # Convert to streaming mode (required when using can_use_tool callback)
            prompt_stream = self._create_prompt_stream(prompt_text)

            # Stream from SDK (NO api_key needed - auto-detects from ~/.claude/config)
            # TODO: Add timeout protection - requires async context manager or timeout task
            async for msg in query(prompt=prompt_stream, options=options):
                # Check for cancellation
                if cancel_event and cancel_event.is_set():
                    logger.info(f"[AGENT SDK] Stream {stream_id} cancelled by user")
                    yield StreamControl(
                        action=StreamControlAction.CANCELLED,
                        stream_id=stream_id,
                        reason="user_request"
                    ).model_dump()
                    return

                # Debug: Log received message (use DEBUG not INFO to reduce log volume)
                logger.debug(f"[AGENT SDK] Received message from SDK: {type(msg).__name__}")

                # Debug: inspect message details
                if is_debug():
                    logger.debug(f"[AGENT SDK] Message attributes: {dir(msg)}")
                    content = getattr(msg, "content", None)
                    if content:
                        logger.debug(f"[AGENT SDK] Message content: {content}")

                # Handle different message types by class name (using constants)
                msg_type = type(msg).__name__

                if msg_type == SDK_MSG_RESULT:
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

                elif msg_type == SDK_MSG_ASSISTANT:
                    # Process content blocks (text and tool use)
                    content = getattr(msg, 'content', None)
                    if not content:
                        continue
                    for block in content:
                        block_type = block.__class__.__name__

                        if block_type == SDK_BLOCK_TEXT:
                            # Yield text content
                            text = getattr(block, 'text', None)
                            if not text:
                                continue
                            logger.debug(f"[AGENT SDK] Yielding text chunk: {len(text)} chars")

                            if is_debug():
                                truncated = text[:LOG_TRUNCATE_LENGTH]
                                if len(text) > LOG_TRUNCATE_LENGTH:
                                    truncated += "..."
                                logger.debug(f"CLAUDE AGENT SDK OUTPUT CHUNK: {truncated}")

                            yield {
                                "type": "response_chunk",
                                "content": text,
                                "done": False
                            }

                        elif block_type == SDK_BLOCK_TOOL_USE:
                            # Track tool execution
                            tool_id = getattr(block, 'id', None)
                            tool_name = getattr(block, 'name', None)
                            tool_input = getattr(block, 'input', None)

                            if not all([tool_id, tool_name, tool_input]):
                                logger.warning(f"[AGENT SDK] ToolUseBlock missing required attributes")
                                continue

                            # Type assertions after validation
                            assert isinstance(tool_id, str) and isinstance(tool_name, str)
                            assert isinstance(tool_input, dict)

                            tool_count += 1
                            logger.info(f"[AGENT SDK] Tool execution started: {tool_name} (id: {tool_id})")

                            yield ToolActivity(
                                tool_id=tool_id,
                                tool_name=tool_name,
                                status=ToolActivityStatus.EXECUTING,
                                input_summary=self._summarize_tool_input(tool_name, tool_input),
                            ).model_dump()

                elif msg_type == SDK_MSG_TOOL_RESULT:
                    # Track tool completion
                    tool_id_value = getattr(msg, "tool_use_id", "unknown")
                    tool_id = str(tool_id_value)  # Ensure it's a string for type safety
                    is_error = bool(getattr(msg, "is_error", False))

                    logger.info(f"[AGENT SDK] Tool execution completed: {tool_id} (error: {is_error})")

                    content = getattr(msg, "content", None)
                    yield ToolActivity(
                        tool_id=tool_id,
                        tool_name="",  # SDK doesn't provide tool name in result
                        status=ToolActivityStatus.FAILED if is_error else ToolActivityStatus.COMPLETED,
                        output_summary=self._summarize_tool_output(content) if content else None,
                    ).model_dump()

                elif msg_type == SDK_MSG_SYSTEM:
                    # Capture session ID and slash_commands from init message (first message)
                    subtype = getattr(msg, 'subtype', None)
                    if subtype == 'init':
                        # Capture session ID from message.data
                        data = getattr(msg, 'data', None)
                        if data and isinstance(data, dict):
                            sdk_session_id = data.get('session_id')
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

                        # Capture slash_commands directly from message attribute
                        slash_commands = getattr(msg, 'slash_commands', None)
                        if slash_commands and not self.slash_commands_initialized:
                            logger.info(f"[AGENT SDK] Captured {len(slash_commands)} slash commands from SDK: {slash_commands[:5]}...")
                            self.slash_commands = slash_commands
                            self.slash_commands_initialized = True
                        elif slash_commands is None:
                            logger.warning("[AGENT SDK] Init message missing slash_commands attribute")
                        else:
                            logger.debug("[AGENT SDK] Init message has empty slash_commands list")
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

    def _summarize_tool_input(self, tool_name: str, input_dict: dict[str, Any]) -> str:
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

    def _summarize_tool_output(
        self,
        content: str | list[ContentBlock] | None
    ) -> str | None:
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
        text_parts: list[str] = []
        for block in content:
            if is_text_block(block):
                # block is now TextBlock - text attribute available
                text: str = block.text
                if len(text) > 100:
                    text_parts.append(text[:100] + "...")
                else:
                    text_parts.append(text)

        return " ".join(text_parts) if text_parts else None

    def _classify_error(self, error: Exception) -> ErrorCode:
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

    def _get_error_message(self, code: ErrorCode, error: Exception) -> str:
        """Get user-friendly error message."""
        messages: dict[ErrorCode, str] = {
            "auth_failed": "Authentication failed. Please run 'claude login' in terminal to authenticate.",
            "permission_denied": "Permission denied. Try switching to bypass mode in session settings.",
            "rate_limit": "Rate limit exceeded. Please try again in a few moments.",
            "timeout": "Request timed out. Please try again.",
            "internal": f"An unexpected error occurred: {str(error)}",
            "execution_failed": "Claude encountered an error while processing your request."
        }
        return messages.get(code, str(error))

    def get_slash_commands(self) -> list[str]:
        """
        Return slash commands from SDK.

        Uses global cache shared across all backend instances, falling back to
        instance cache if available.

        Returns:
            List of slash command names (e.g., ['compact', 'clear', 'commit'])
        """
        global _SLASH_COMMANDS_CACHE

        # Prefer global cache (shared across all instances)
        if _SLASH_COMMANDS_CACHE:
            return _SLASH_COMMANDS_CACHE

        # Fallback to instance cache
        return self.slash_commands

    async def _can_use_tool_callback(
        self,
        tool_name: str,
        input_data: dict[str, Any],
        context: ToolPermissionContext
    ) -> PermissionResult:
        """
        Permission callback for Claude Agent SDK.

        Handles two flows:
        1. Tool permission requests (Bash, Write, Edit, etc.)
        2. AskUserQuestion prompts (multi-choice questions from Claude)

        Returns:
            PermissionResultAllow: If approved (with optional modified input)
            PermissionResultDeny: If denied or timeout (with reason message)
        """
        # Meta tools that manage workflow (don't require user permission)
        META_TOOLS: set[MetaToolName] = {
            "AskUserQuestion",  # Multi-choice questions (has special handling)
            "EnterPlanMode",    # Start planning mode
            "ExitPlanMode",     # Exit planning mode
            "TaskCreate",       # Create task in task list
            "TaskUpdate",       # Update task status
            "TaskGet",          # Get task details
            "TaskList",         # List all tasks
            "Skill",            # Invoke skills
        }

        # Auto-approve meta tools
        if tool_name in META_TOOLS:
            # Special handling for AskUserQuestion (show UI prompt)
            if tool_name == "AskUserQuestion":
                return await self._handle_ask_user_question(input_data)
            # All other meta tools auto-approve
            return PermissionResultAllow(updated_input=input_data)

        # Bypass mode: auto-approve everything
        if self.permission_mode == "bypassPermissions":
            return PermissionResultAllow(updated_input=input_data)

        # For other modes, request user approval
        return await self._request_permission_from_ui(tool_name, input_data, context)

    async def _request_permission_from_ui(
        self,
        tool_name: str,
        input_data: dict[str, Any],
        context: ToolPermissionContext
    ) -> PermissionResult:
        """Send permission request to UI and wait for user response."""
        logger.info(f"[PERMISSION] _request_permission_from_ui called for tool: {tool_name}")
        logger.info(f"[PERMISSION] ws_send_callback exists: {self.ws_send_callback is not None}")

        if not self.ws_send_callback:
            logger.warning("No WebSocket callback, denying permission")
            return PermissionResultDeny(message="No UI connection available")

        # Create permission request
        request_id, event = self.permission_manager.create_request()
        logger.info(f"[PERMISSION] Created request_id: {request_id}")

        # Send request to UI via WebSocket with error handling
        try:
            permission_msg = {
                "type": "permission_request",
                "request_id": request_id,
                "request_type": "tool_approval",
                "tool_name": tool_name,
                "input_data": input_data,
                "timeout_seconds": 60,
                "timestamp": datetime.utcnow().isoformat()
            }
            logger.info(f"[PERMISSION] Sending permission request to UI: {permission_msg}")
            await self.ws_send_callback(permission_msg)
            logger.info(f"[PERMISSION] Permission request sent successfully")
        except Exception as e:
            # WebSocket send failed (disconnection, etc.)
            self.permission_manager.cleanup_request(request_id)
            logger.error(f"[PERMISSION] Failed to send permission request: {e}", exc_info=True)
            return PermissionResultDeny(message=f"Connection lost: {e}")

        # Wait for user response with 60s timeout
        try:
            await asyncio.wait_for(event.wait(), timeout=60.0)

            # Get result
            result = self.permission_manager._pending_requests[request_id]["result"]
            self.permission_manager.cleanup_request(request_id)

            if result is None:
                return PermissionResultDeny(message="No response received")

            if result["approved"]:
                return PermissionResultAllow(
                    updated_input=result.get("modified_input") or input_data
                )
            else:
                return PermissionResultDeny(
                    message=result.get("reason") or "User denied permission"
                )

        except asyncio.TimeoutError:
            self.permission_manager.cleanup_request(request_id)
            logger.warning(f"Permission request {request_id} timed out")
            return PermissionResultDeny(
                message="Permission request timed out (60 seconds)"
            )

    async def _handle_ask_user_question(
        self,
        input_data: dict[str, Any]
    ) -> PermissionResult:
        """Handle AskUserQuestion tool - display multi-choice questions to user."""
        if not self.ws_send_callback:
            return PermissionResultDeny(message="No UI connection available")

        request_id, event = self.permission_manager.create_request()

        # Send AskUserQuestion request to UI
        try:
            await self.ws_send_callback({
                "type": "permission_request",
                "request_id": request_id,
                "request_type": "ask_user_question",
                "questions": input_data.get("questions", []),
                "timeout_seconds": 60,
                "timestamp": datetime.utcnow().isoformat()
            })
        except Exception as e:
            self.permission_manager.cleanup_request(request_id)
            logger.warning(f"Failed to send AskUserQuestion request: {e}")
            return PermissionResultDeny(message=f"Connection lost: {e}")

        # Wait for answers with timeout
        try:
            await asyncio.wait_for(event.wait(), timeout=60.0)

            result = self.permission_manager._pending_requests[request_id]["result"]
            self.permission_manager.cleanup_request(request_id)

            if result is None:
                return PermissionResultDeny(message="No response received")

            if result["approved"]:
                # Return answers in SDK format
                return PermissionResultAllow(
                    updated_input={
                        "questions": input_data.get("questions", []),
                        "answers": result.get("answers", {})
                    }
                )
            else:
                return PermissionResultDeny(message="User did not answer")

        except asyncio.TimeoutError:
            self.permission_manager.cleanup_request(request_id)
            return PermissionResultDeny(message="Question timed out (60 seconds)")

    def resolve_permission(self, request_id: str, response: PermissionResponse) -> None:
        """
        Called by WebSocket handler to resolve a permission request.

        Args:
            request_id: Unique identifier from permission_request
            response: User's response containing approved, modified_input, answers, reason
        """
        self.permission_manager.resolve_request(request_id, response)

    async def shutdown(self) -> None:
        """
        Cleanup resources and resolve pending permission requests.

        Called when:
        - Backend is being recreated (e.g., permission mode change)
        - Session is being destroyed
        - Service is shutting down

        This ensures SDK queries don't hang when backend is replaced.
        """
        # Deny all pending permissions
        for request_id in list(self.permission_manager._pending_requests.keys()):
            response: PermissionResponse = {
                "approved": False,
                "reason": "Backend shutdown during pending request"
            }
            self.permission_manager.resolve_request(request_id, response)

        logger.info("Claude Agent SDK backend shutdown complete")
