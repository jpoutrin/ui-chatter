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

        # Verify we got content
        assert len(chunks) == 2
        assert chunks[0]["type"] == "response_chunk"
        assert chunks[0]["content"] == "Hello from Claude!"
        assert chunks[0]["done"] is False
        assert chunks[1]["done"] is True


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

        assert len(chunks) == 3
        assert chunks[0]["content"] == "Part 1 "
        assert chunks[1]["content"] == "Part 2"


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

        # Only text from TextBlock should be extracted
        assert len(chunks) == 2
        assert chunks[0]["content"] == "Let me check... "
        assert "Read" not in chunks[0]["content"]


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

        assert len(chunks) == 1
        assert chunks[0]["type"] == "error"
        assert chunks[0]["code"] == "auth_failed"
        assert "claude login" in chunks[0]["message"]


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

        assert len(chunks) == 1
        assert chunks[0]["type"] == "error"
        assert chunks[0]["code"] == "permission_denied"


def test_extract_text_content_single_block(backend):
    """Test text extraction from single TextBlock."""
    msg = MagicMock()
    block = TextBlock("Test content")
    msg.content = [block]

    result = backend._extract_text_content(msg)
    assert result == "Test content"


def test_extract_text_content_multiple_blocks(backend):
    """Test text extraction from multiple TextBlocks."""
    msg = MagicMock()
    block1 = TextBlock("Hello ")
    block2 = TextBlock("World")
    msg.content = [block1, block2]

    result = backend._extract_text_content(msg)
    assert result == "Hello World"


def test_extract_text_content_no_content_attribute(backend):
    """Test text extraction when message has no content."""
    msg = MagicMock(spec=[])  # No content attribute
    result = backend._extract_text_content(msg)
    assert result == ""


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
