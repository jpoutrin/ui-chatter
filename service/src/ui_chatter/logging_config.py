"""Logging configuration for UI Chatter."""

import logging
import sys
from typing import Optional


def setup_logging(level: str = "INFO", debug: bool = False) -> None:
    """
    Configure logging for the application.

    Args:
        level: Log level (DEBUG, INFO, WARNING, ERROR, CRITICAL)
        debug: Enable debug mode with verbose formatting
    """
    log_level = logging.DEBUG if debug else getattr(logging, level.upper(), logging.INFO)

    # Format
    if debug:
        log_format = (
            "%(asctime)s | %(levelname)-8s | %(name)s:%(lineno)d | %(message)s"
        )
    else:
        log_format = "%(asctime)s | %(levelname)-8s | %(message)s"

    # Configure root logger
    logging.basicConfig(
        level=log_level,
        format=log_format,
        datefmt="%Y-%m-%d %H:%M:%S",
        handlers=[logging.StreamHandler(sys.stdout)],
    )

    # Set uvicorn loggers to match
    logging.getLogger("uvicorn").setLevel(log_level)
    logging.getLogger("uvicorn.access").setLevel(
        logging.DEBUG if debug else logging.WARNING
    )
    logging.getLogger("uvicorn.error").setLevel(log_level)

    # Suppress noisy third-party loggers
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)


def get_logger(name: str) -> logging.Logger:
    """Get a logger instance for a module."""
    return logging.getLogger(name)
