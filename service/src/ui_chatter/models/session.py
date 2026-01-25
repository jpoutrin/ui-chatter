"""Session state models."""

from datetime import datetime
from typing import Optional
from pydantic import BaseModel, Field


class AgentSession(BaseModel):
    """Represents an agent session with state."""

    session_id: str = Field(..., description="Unique session identifier")
    project_path: str = Field(..., description="Path to the project directory")
    created_at: datetime = Field(
        default_factory=datetime.now, description="Session creation time"
    )
    last_activity: datetime = Field(
        default_factory=datetime.now, description="Last activity timestamp"
    )
    metadata: dict = Field(default_factory=dict, description="Session metadata")

    class Config:
        """Pydantic configuration."""

        arbitrary_types_allowed = True
