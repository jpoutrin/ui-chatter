"""Custom exception classes for UI Chatter."""


class UIChatterError(Exception):
    """Base exception for UI Chatter errors."""

    def __init__(self, message: str, code: str = "internal", detail: str = ""):
        self.message = message
        self.code = code
        self.detail = detail
        super().__init__(message)


class AgentError(UIChatterError):
    """Errors related to Claude Agent operations."""

    pass


class AgentAuthError(AgentError):
    """Authentication with Claude failed."""

    def __init__(self, message: str = "Authentication failed"):
        super().__init__(message, code="auth_failed")


class AgentRateLimitError(AgentError):
    """Rate limit exceeded."""

    def __init__(self, message: str = "Rate limit exceeded"):
        super().__init__(message, code="rate_limit")


class AgentTimeoutError(AgentError):
    """Request timed out."""

    def __init__(self, message: str = "Request timed out"):
        super().__init__(message, code="timeout")


class SessionError(UIChatterError):
    """Errors related to session management."""

    pass


class SessionNotFoundError(SessionError):
    """Session not found."""

    def __init__(self, session_id: str):
        super().__init__(f"Session not found: {session_id}", code="session_not_found")


class ConnectionError(UIChatterError):
    """Errors related to WebSocket connections."""

    pass


class InvalidOriginError(ConnectionError):
    """Invalid WebSocket origin."""

    def __init__(self, origin: str):
        super().__init__(
            f"Invalid origin: {origin}. Only chrome-extension:// allowed.",
            code="invalid_origin",
        )


class ConnectionLimitError(ConnectionError):
    """Connection limit reached."""

    def __init__(self, limit: int):
        super().__init__(
            f"Connection limit reached: {limit} concurrent connections",
            code="connection_limit",
        )
