"""Application configuration with environment variable support."""

from typing import List, Optional, Literal
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """
    Application settings with environment variable support.

    Priority: ENV > .env.local > .env > defaults
    .env.local is gitignored for local overrides
    """

    model_config = SettingsConfigDict(
        env_file=(".env", ".env.local"),
        env_file_encoding="utf-8",
        case_sensitive=True,
    )

    # Service configuration
    PROJECT_NAME: str = "UI Chatter"
    PROJECT_PATH: str = "."  # Project directory to work in
    DEBUG: bool = False
    HOST: str = "localhost"
    PORT: int = 3456
    LOG_LEVEL: str = "INFO"

    # Claude Agent SDK configuration (subscription-based auth from ~/.claude/config)
    PERMISSION_MODE: Literal[
        "acceptEdits", "bypassPermissions", "default", "delegate", "dontAsk", "plan"
    ] = "bypassPermissions"

    # Storage
    MAX_SCREENSHOT_AGE_HOURS: int = 24
    MAX_SESSION_IDLE_MINUTES: int = 30

    # Security
    ALLOWED_ORIGINS: List[str] = ["chrome-extension://"]
    MAX_CONNECTIONS: int = 100

    # Performance
    WORKER_COUNT: int = 1  # Uvicorn workers

    # WebSocket keepalive configuration
    WS_PING_INTERVAL: int = 25          # Application ping interval (seconds)
    WS_PING_TIMEOUT: int = 30           # Application pong timeout (seconds)
    WS_RECEIVE_TIMEOUT: int = 300       # Max wait for any message (seconds)
    WS_PROTOCOL_PING_INTERVAL: float = 15.0  # Protocol ping interval (seconds)
    WS_PROTOCOL_PING_TIMEOUT: float = 10.0   # Protocol pong timeout (seconds)


# Global settings instance
settings = Settings()
