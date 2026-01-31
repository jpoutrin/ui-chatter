"""Common type definitions for UI Chatter.

This module provides TypedDict definitions for common data structures
to improve type safety and avoid Dict[str, Any].
"""

from typing import Any, Awaitable, Callable, Dict, List, Optional, TypedDict, Union


class ResponseChunkDict(TypedDict, total=False):
    """Response chunk from agent backend."""
    type: str
    content: str
    done: bool


class ToolActivityDict(TypedDict, total=False):
    """Tool execution activity tracking."""
    type: str
    tool_id: str
    tool_name: str
    status: str
    input_summary: Optional[str]
    output_summary: Optional[str]
    duration_ms: Optional[int]
    timestamp: str


class StreamControlDict(TypedDict, total=False):
    """Stream lifecycle control message."""
    type: str
    action: str
    stream_id: str
    reason: Optional[str]
    metadata: Optional[Dict[str, Any]]


class SessionEstablishedDict(TypedDict, total=False):
    """Session established notification."""
    type: str
    sdk_session_id: str


class ErrorDict(TypedDict, total=False):
    """Error message."""
    type: str
    code: str
    message: str
    detail: Optional[str]


class StatusDict(TypedDict, total=False):
    """Status update message."""
    type: str
    status: str
    detail: Optional[str]


# Union of all possible WebSocket message types
WebSocketMessage = Union[
    ResponseChunkDict,
    ToolActivityDict,
    StreamControlDict,
    SessionEstablishedDict,
    ErrorDict,
    StatusDict,
    Dict[str, Any],  # Fallback for unknown message types
]


class SessionMetadata(TypedDict, total=False):
    """Session metadata structure."""
    created_at: str
    last_activity: str
    project_path: str
    permission_mode: str
    sdk_session_id: Optional[str]


class FileMetadata(TypedDict):
    """File metadata from project file listing."""
    relative_path: str
    size: int
    modified_at: float
    type: str


class CommandMetadata(TypedDict, total=False):
    """Command metadata from command discovery."""
    name: str
    command: str
    description: Optional[str]
    category: Optional[str]
    mode: str
    allowed_tools: Optional[List[str]]
    argument_hint: Optional[str]
    model: Optional[str]


# Type alias for WebSocket send callback
WsSendCallback = Callable[[WebSocketMessage], Awaitable[None]]
