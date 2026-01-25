"""Application configuration with environment variable support."""

from typing import List, Optional
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """
    Application settings with environment variable support.

    Priority: ENV > .env file > defaults
    """

    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", case_sensitive=True
    )

    # Service configuration
    PROJECT_NAME: str = "UI Chatter"
    DEBUG: bool = False
    HOST: str = "localhost"
    PORT: int = 3456
    LOG_LEVEL: str = "INFO"

    # Claude API configuration
    ANTHROPIC_API_KEY: Optional[str] = None  # Fallback if OAuth unavailable

    # Storage
    MAX_SCREENSHOT_AGE_HOURS: int = 24
    MAX_SESSION_IDLE_MINUTES: int = 30

    # Security
    ALLOWED_ORIGINS: List[str] = ["chrome-extension://"]
    MAX_CONNECTIONS: int = 100

    # Performance
    WORKER_COUNT: int = 1  # Uvicorn workers


# Global settings instance
settings = Settings()
