"""WebSocket message models."""

from datetime import datetime
from enum import Enum
from typing import Any, Dict, Literal, Optional
from pydantic import BaseModel, Field

from .context import CapturedContext

# Valid permission modes
PermissionMode = Literal[
    "acceptEdits", "bypassPermissions", "default", "delegate", "dontAsk", "plan"
]


class ChatRequest(BaseModel):
    """Chat request from extension."""

    type: Literal["chat"] = "chat"
    context: CapturedContext = Field(..., description="Captured UI context")
    screenshot: Optional[str] = Field(None, description="Base64-encoded screenshot")
    message: str = Field(..., description="User's message")


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
    input_summary: Optional[str] = Field(None, description="Abbreviated tool input")
    output_summary: Optional[str] = Field(None, description="Abbreviated tool output")
    duration_ms: Optional[int] = Field(None, description="Execution time in milliseconds")
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
    reason: Optional[str] = Field(None, description="Reason for state change")
    metadata: Optional[Dict[str, Any]] = Field(None, description="Additional context")
