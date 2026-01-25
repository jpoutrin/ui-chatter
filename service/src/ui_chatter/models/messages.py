"""WebSocket message models."""

from typing import Literal, Optional
from pydantic import BaseModel, Field

from .context import CapturedContext


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
