"""Schema definitions for API requests/responses."""

from .websocket import WSChatRequest, WSResponse
from .config import ConfigSchema

__all__ = [
    "WSChatRequest",
    "WSResponse",
    "ConfigSchema",
]
