"""Tests for session switching functionality."""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from ui_chatter.session_manager import SessionManager, AgentSession
from ui_chatter.backends.base import AgentBackend


@pytest.mark.asyncio
async def test_switch_sdk_session_preserves_callback():
    """Test that switching SDK sessions preserves the WebSocket callback."""
    # Create session manager
    manager = SessionManager(project_path="/test/project", permission_mode="plan")

    # Create mock callback
    mock_callback = AsyncMock()

    # Create mock backend
    mock_backend = MagicMock(spec=AgentBackend)
    mock_backend.shutdown = AsyncMock()
    mock_backend.sdk_session_id = "old-sdk-session"
    mock_backend.has_established_session = True

    # Create session with callback
    session = AgentSession(
        session_id="test-session",
        project_path="/test/project",
        backend=mock_backend,
        permission_mode="plan",
        ws_send_callback=mock_callback
    )

    manager.sessions["test-session"] = session

    # Mock _create_backend to capture the callback parameter
    created_backend = MagicMock(spec=AgentBackend)
    created_callback = None

    def mock_create_backend(session_id, project_path, permission_mode=None,
                           resume_session_id=None, fork_session=False,
                           ws_send_callback=None):
        nonlocal created_callback
        created_callback = ws_send_callback
        return created_backend

    manager._create_backend = mock_create_backend

    # Switch to new SDK session
    await manager.switch_sdk_session("test-session", "new-sdk-session")

    # Verify callback was preserved
    assert created_callback is mock_callback, "WebSocket callback was not preserved during session switch"
    assert session.backend is created_backend, "Backend was not updated"


@pytest.mark.asyncio
async def test_switch_sdk_session_shuts_down_old_backend():
    """Test that switching SDK sessions properly shuts down the old backend."""
    manager = SessionManager(project_path="/test/project", permission_mode="plan")

    # Create mock backend with shutdown tracking
    mock_old_backend = MagicMock(spec=AgentBackend)
    mock_old_backend.shutdown = AsyncMock()
    mock_old_backend.sdk_session_id = "old-sdk-session"

    session = AgentSession(
        session_id="test-session",
        project_path="/test/project",
        backend=mock_old_backend,
        permission_mode="plan"
    )

    manager.sessions["test-session"] = session

    # Mock _create_backend
    new_backend = MagicMock(spec=AgentBackend)
    manager._create_backend = lambda *args, **kwargs: new_backend

    # Switch session
    await manager.switch_sdk_session("test-session", "new-sdk-session")

    # Verify old backend was shut down
    mock_old_backend.shutdown.assert_awaited_once()


@pytest.mark.asyncio
async def test_switch_sdk_session_updates_store():
    """Test that switching SDK sessions updates the session store."""
    from ui_chatter.session_store import SessionStore

    # Create mock session store
    mock_store = MagicMock(spec=SessionStore)
    mock_store.set_sdk_session_id = AsyncMock()

    manager = SessionManager(
        project_path="/test/project",
        permission_mode="plan",
        session_store=mock_store
    )

    # Create session
    mock_backend = MagicMock(spec=AgentBackend)
    mock_backend.shutdown = AsyncMock()
    mock_backend.sdk_session_id = "old-sdk-session"

    session = AgentSession(
        session_id="test-session",
        project_path="/test/project",
        backend=mock_backend,
        permission_mode="plan"
    )

    manager.sessions["test-session"] = session

    # Mock _create_backend
    new_backend = MagicMock(spec=AgentBackend)
    manager._create_backend = lambda *args, **kwargs: new_backend

    # Switch session
    new_sdk_id = "new-sdk-session"
    await manager.switch_sdk_session("test-session", new_sdk_id)

    # Verify store was updated
    mock_store.set_sdk_session_id.assert_awaited_once_with("test-session", new_sdk_id)


@pytest.mark.asyncio
async def test_switch_sdk_session_with_nonexistent_session():
    """Test that switching a nonexistent session raises ValueError."""
    manager = SessionManager(project_path="/test/project", permission_mode="plan")

    with pytest.raises(ValueError, match="Session nonexistent not found"):
        await manager.switch_sdk_session("nonexistent", "new-sdk-session")


@pytest.mark.asyncio
async def test_switch_sdk_session_passes_correct_parameters():
    """Test that switch_sdk_session passes correct parameters to _create_backend."""
    manager = SessionManager(project_path="/test/project", permission_mode="plan")

    mock_callback = AsyncMock()
    mock_backend = MagicMock(spec=AgentBackend)
    mock_backend.shutdown = AsyncMock()

    session = AgentSession(
        session_id="test-session",
        project_path="/custom/path",
        backend=mock_backend,
        permission_mode="acceptEdits",
        ws_send_callback=mock_callback
    )

    manager.sessions["test-session"] = session

    # Track _create_backend calls
    create_calls = []

    def track_create(*args, **kwargs):
        create_calls.append({'args': args, 'kwargs': kwargs})
        return MagicMock(spec=AgentBackend)

    manager._create_backend = track_create

    # Switch session
    await manager.switch_sdk_session("test-session", "new-sdk-session-123")

    # Verify _create_backend was called with correct parameters
    assert len(create_calls) == 1
    call = create_calls[0]

    # Check positional args
    assert call['args'][0] == "test-session"
    assert call['args'][1] == "/custom/path"

    # Check keyword args
    assert call['kwargs']['permission_mode'] == "acceptEdits"
    assert call['kwargs']['resume_session_id'] == "new-sdk-session-123"
    assert call['kwargs']['ws_send_callback'] is mock_callback
    assert call['kwargs'].get('fork_session', False) == False
