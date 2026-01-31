"""Unit tests for Claude Agent SDK backend."""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from ui_chatter.backends.claude_agent_sdk import ClaudeAgentSDKBackend
from ui_chatter.models.context import CapturedContext, CapturedElement, PageInfo


# Mock block classes that mimic SDK block types
class TextBlock:
    """Mock TextBlock class."""
    def __init__(self, text: str):
        self.text = text


class ToolUseBlock:
    """Mock ToolUseBlock class."""
    def __init__(self, name: str, input_data: dict):
        self.name = name
        self.input = input_data


# Mock message classes that mimic SDK message types
class AssistantMessage:
    """Mock AssistantMessage class."""
    def __init__(self, content: list):
        self.content = content


class ResultMessage:
    """Mock ResultMessage class (final message)."""
    pass


@pytest.fixture
def backend():
    """Create backend instance for testing."""
    return ClaudeAgentSDKBackend(
        project_path="/tmp/test-project",
        permission_mode="bypassPermissions"
    )


@pytest.fixture
def mock_context():
    """Create mock captured context."""
    return CapturedContext(
        element=CapturedElement(
            tagName="button",
            textContent="Login",
            attributes={"class": "btn btn-primary"}
        ),
        page=PageInfo(
            url="https://example.com/login",
            title="Login Page"
        )
    )


@pytest.mark.asyncio
async def test_handle_chat_extracts_text_from_textblock(backend, mock_context):
    """Test that TextBlock content is correctly extracted."""
    async def mock_query(prompt, options):
        # Mock AssistantMessage with TextBlock
        text_block = TextBlock("Hello from Claude!")
        msg = AssistantMessage([text_block])
        yield msg

        # Mock result message
        result_msg = ResultMessage()
        yield result_msg

    with patch("ui_chatter.backends.claude_agent_sdk.query", mock_query):
        chunks = []
        async for chunk in backend.handle_chat(mock_context, "test"):
            chunks.append(chunk)

        # Verify we got stream_control(STARTED), response_chunk, done chunk, stream_control(COMPLETED)
        assert len(chunks) == 4
        assert chunks[0]["type"] == "stream_control"
        assert chunks[0]["action"] == "started"
        assert chunks[1]["type"] == "response_chunk"
        assert chunks[1]["content"] == "Hello from Claude!"
        assert chunks[1]["done"] is False
        assert chunks[2]["done"] is True
        assert chunks[3]["type"] == "stream_control"
        assert chunks[3]["action"] == "completed"


@pytest.mark.asyncio
async def test_handle_chat_handles_multiple_textblocks(backend, mock_context):
    """Test extraction of multiple TextBlock messages."""
    async def mock_query(prompt, options):
        # First message
        block1 = TextBlock("Part 1 ")
        msg1 = AssistantMessage([block1])
        yield msg1

        # Second message
        block2 = TextBlock("Part 2")
        msg2 = AssistantMessage([block2])
        yield msg2

        # Result
        result = ResultMessage()
        yield result

    with patch("ui_chatter.backends.claude_agent_sdk.query", mock_query):
        chunks = []
        async for chunk in backend.handle_chat(mock_context, "test"):
            chunks.append(chunk)

        # stream_control(STARTED), response_chunk(Part 1), response_chunk(Part 2), done chunk, stream_control(COMPLETED)
        assert len(chunks) == 5
        assert chunks[0]["type"] == "stream_control"
        assert chunks[1]["content"] == "Part 1 "
        assert chunks[2]["content"] == "Part 2"
        assert chunks[3]["done"] is True
        assert chunks[4]["type"] == "stream_control"


@pytest.mark.asyncio
async def test_handle_chat_skips_tooluse_blocks(backend, mock_context):
    """Test that ToolUseBlock is skipped (no text output)."""
    async def mock_query(prompt, options):
        # Message with both TextBlock and ToolUseBlock
        text_block = TextBlock("Let me check... ")
        tool_block = ToolUseBlock("Read", {"file_path": "test.py"})

        msg = AssistantMessage([text_block, tool_block])
        yield msg

        # Result
        result = ResultMessage()
        yield result

    with patch("ui_chatter.backends.claude_agent_sdk.query", mock_query):
        chunks = []
        async for chunk in backend.handle_chat(mock_context, "test"):
            chunks.append(chunk)

        # stream_control(STARTED), response_chunk(text), done chunk, stream_control(COMPLETED)
        assert len(chunks) == 4
        assert chunks[0]["type"] == "stream_control"
        assert chunks[1]["content"] == "Let me check... "
        assert "Read" not in chunks[1]["content"]
        assert chunks[2]["done"] is True
        assert chunks[3]["type"] == "stream_control"


@pytest.mark.asyncio
async def test_handle_chat_auth_error(backend, mock_context):
    """Test authentication error handling."""
    async def mock_query_error(prompt, options):
        raise Exception("Authentication failed: no credentials")
        yield

    with patch("ui_chatter.backends.claude_agent_sdk.query", mock_query_error):
        chunks = []
        async for chunk in backend.handle_chat(mock_context, "test"):
            chunks.append(chunk)

        # stream_control(STARTED), error
        assert len(chunks) == 2
        assert chunks[0]["type"] == "stream_control"
        assert chunks[1]["type"] == "error"
        assert chunks[1]["code"] == "auth_failed"
        assert "claude login" in chunks[1]["message"]


@pytest.mark.asyncio
async def test_handle_chat_permission_error(backend, mock_context):
    """Test permission error handling."""
    async def mock_query_error(prompt, options):
        raise Exception("Permission denied for tool")
        yield

    with patch("ui_chatter.backends.claude_agent_sdk.query", mock_query_error):
        chunks = []
        async for chunk in backend.handle_chat(mock_context, "test"):
            chunks.append(chunk)

        # stream_control(STARTED), error
        assert len(chunks) == 2
        assert chunks[0]["type"] == "stream_control"
        assert chunks[1]["type"] == "error"
        assert chunks[1]["code"] == "permission_denied"


def test_classify_error_types(backend):
    """Test error classification."""
    assert backend._classify_error(Exception("auth failed")) == "auth_failed"
    assert backend._classify_error(Exception("credential invalid")) == "auth_failed"
    assert backend._classify_error(Exception("permission denied")) == "permission_denied"
    assert backend._classify_error(Exception("rate limit exceeded")) == "rate_limit"
    assert backend._classify_error(Exception("timeout occurred")) == "timeout"
    assert backend._classify_error(Exception("unknown error")) == "internal"


def test_get_error_message(backend):
    """Test error message generation."""
    msg = backend._get_error_message("auth_failed", Exception("test"))
    assert "claude login" in msg

    msg = backend._get_error_message("rate_limit", Exception("test"))
    assert "rate limit" in msg.lower()

    msg = backend._get_error_message("timeout", Exception("test"))
    assert "timed out" in msg.lower()

    msg = backend._get_error_message("internal", Exception("custom error"))
    assert "custom error" in msg


@pytest.mark.asyncio
async def test_shutdown_no_error(backend):
    """Test shutdown completes without errors."""
    await backend.shutdown()  # Should complete without raising


def test_backend_initialization(backend):
    """Test backend initializes with correct parameters."""
    assert backend.project_path == "/tmp/test-project"
    assert backend.permission_mode == "bypassPermissions"
    assert "Read" in backend.allowed_tools
    assert "Write" in backend.allowed_tools
    assert "Edit" in backend.allowed_tools
    assert "Bash" in backend.allowed_tools
    assert "Glob" in backend.allowed_tools
    assert "Grep" in backend.allowed_tools


def test_backend_custom_permission_mode():
    """Test backend with custom permission mode."""
    backend = ClaudeAgentSDKBackend(
        project_path="/tmp/test",
        permission_mode="plan"
    )
    assert backend.permission_mode == "plan"
