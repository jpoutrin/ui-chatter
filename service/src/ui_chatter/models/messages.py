"""WebSocket message models."""

from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Literal, Optional
from pydantic import BaseModel, ConfigDict, Field

from .context import CapturedContext

# Valid permission modes (matching Claude Agent SDK's ClaudeAgentOptions)
PermissionMode = Literal[
    "acceptEdits", "bypassPermissions", "default", "plan"
]


class ChatRequest(BaseModel):
    """Chat request from extension."""

    # Allow both 'context' and 'element_context' as field names
    model_config = ConfigDict(populate_by_name=True)

    type: Literal["chat"] = "chat"
    message: str = Field(..., description="User's message")
    context: Optional[CapturedContext] = Field(
        None,
        alias="element_context",  # Accept 'element_context' from extension
        description="Captured UI context (optional)"
    )
    selected_text: Optional[str] = Field(
        None,
        description="Selected text from the page (optional)"
    )
    screenshot: Optional[str] = Field(None, description="Base64-encoded screenshot")


class ResponseChunk(BaseModel):
    """Streaming response chunk to extension."""

    type: Literal["response_chunk"] = "response_chunk"
    content: str = Field(..., description="Response content chunk")
    done: bool = Field(..., description="Whether this is the final chunk")


class StatusUpdate(BaseModel):
    """Status update message."""

    type: Literal["status"] = "status"
    status: Literal["idle", "thinking", "done", "error"] = Field(
        ..., description="Current status"
    )
    detail: Optional[str] = Field(None, description="Additional status information")


class ErrorMessage(BaseModel):
    """Error message to extension."""

    type: Literal["error"] = "error"
    code: str = Field(..., description="Error code")
    message: str = Field(..., description="Human-readable error message")
    detail: Optional[str] = Field(None, description="Additional error details")


class HandshakeMessage(BaseModel):
    """Initial connection with permission mode."""

    type: Literal["handshake"] = "handshake"
    permission_mode: PermissionMode = Field(
        "plan", description="Permission mode for Claude CLI"
    )
    page_url: Optional[str] = Field(
        None,
        description="Current page URL for auto-resume"
    )
    tab_id: Optional[str] = Field(
        None,
        description="Browser tab ID for session isolation"
    )


class UpdatePermissionModeMessage(BaseModel):
    """Runtime permission mode update."""

    type: Literal["update_permission_mode"] = "update_permission_mode"
    mode: PermissionMode = Field(..., description="New permission mode")


class PermissionModeUpdatedMessage(BaseModel):
    """Acknowledgment of permission mode update."""

    type: Literal["permission_mode_updated"] = "permission_mode_updated"
    mode: PermissionMode = Field(..., description="Current permission mode")


# Multi-channel streaming protocol models

class ToolActivityStatus(str, Enum):
    """Tool execution status."""
    PENDING = "pending"
    EXECUTING = "executing"
    COMPLETED = "completed"
    FAILED = "failed"


class ToolActivity(BaseModel):
    """Real-time tool execution tracking."""

    type: Literal["tool_activity"] = "tool_activity"
    tool_id: str = Field(..., description="Unique identifier for this tool call")
    tool_name: str = Field(..., description="Tool name (Read, Write, Edit, Bash, etc.)")
    status: ToolActivityStatus = Field(..., description="Current status of tool execution")
    input_summary: Optional[str] = Field(default=None, description="Abbreviated tool input")
    output_summary: Optional[str] = Field(default=None, description="Abbreviated tool output")
    duration_ms: Optional[int] = Field(default=None, description="Execution time in milliseconds")
    timestamp: datetime = Field(default_factory=datetime.utcnow)


class StreamControlAction(str, Enum):
    """Stream lifecycle actions."""
    STARTED = "started"
    PAUSED = "paused"
    RESUMED = "resumed"
    CANCELLED = "cancelled"
    COMPLETED = "completed"


class StreamControl(BaseModel):
    """Stream lifecycle control."""

    type: Literal["stream_control"] = "stream_control"
    action: StreamControlAction = Field(..., description="Stream lifecycle action")
    stream_id: str = Field(..., description="Unique stream session identifier")
    reason: Optional[str] = Field(default=None, description="Reason for state change")
    metadata: Optional[Dict[str, Any]] = Field(default=None, description="Additional context")


# Permission support models

class PermissionRequest(BaseModel):
    """Permission request sent to UI."""

    type: Literal["permission_request"] = "permission_request"
    request_id: str = Field(..., description="UUID unique identifier")
    request_type: Literal["tool_approval", "ask_user_question"] = Field(..., description="Type of permission request")
    tool_name: Optional[str] = Field(None, description="Tool name (for tool_approval)")
    input_data: Optional[Dict[str, Any]] = Field(None, description="Tool parameters (for tool_approval)")
    questions: Optional[List[Any]] = Field(None, description="Questions (for ask_user_question)")
    timeout_seconds: int = Field(default=60, description="Seconds until auto-deny")
    timestamp: str = Field(..., description="ISO 8601 timestamp")


class PermissionResponse(BaseModel):
    """Permission response from UI."""

    type: Literal["permission_response"] = "permission_response"
    request_id: str = Field(..., description="Request ID from permission_request")
    approved: bool = Field(..., description="True if user approved")
    modified_input: Optional[Dict[str, Any]] = Field(None, description="Modified tool parameters (optional)")
    answers: Optional[Dict[str, str]] = Field(None, description="Question answers (for ask_user_question)")
    reason: Optional[str] = Field(None, description="Denial reason (if approved=false)")
