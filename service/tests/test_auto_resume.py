"""Tests for auto-resume functionality."""

import pytest
import asyncio
from datetime import datetime, timedelta
from pathlib import Path
import tempfile
import shutil
from unittest.mock import AsyncMock, patch

from ui_chatter.session_manager import SessionManager
from ui_chatter.session_store import SessionStore


@pytest.fixture
async def temp_project():
    """Create temporary project directory."""
    temp_dir = tempfile.mkdtemp()
    yield temp_dir
    shutil.rmtree(temp_dir)


@pytest.fixture
async def session_store(temp_project):
    """Create session store for testing."""
    store = SessionStore(project_path=temp_project)
    await store.initialize()
    return store


@pytest.fixture
async def mock_slash_commands():
    """Mock initialize_slash_commands to avoid SDK calls in tests."""
    with patch('ui_chatter.backends.claude_agent_sdk.ClaudeAgentSDKBackend.initialize_slash_commands', new_callable=AsyncMock) as mock:
        mock.return_value = None
        yield mock


@pytest.fixture
async def session_manager(temp_project, session_store, mock_slash_commands):
    """Create session manager for testing."""
    manager = SessionManager(
        max_idle_minutes=30,
        project_path=temp_project,
        permission_mode="plan",
        session_store=session_store,
        session_repository=None,
    )
    yield manager
    await manager.cleanup_all_sessions()


@pytest.mark.asyncio
async def test_auto_resume_same_url_tab_recent(session_manager):
    """Should resume when same URL and tab within time window."""
    # Create first session
    session1 = await session_manager.create_session(
        "session1",
        page_url="https://example.com/app",
        tab_id="tab-123",
        auto_resume=True
    )

    # Simulate SDK session establishment
    await session_manager.update_sdk_session_id("session1", "sdk-session-abc")

    # Simulate reconnection (new WebSocket session)
    session2 = await session_manager.create_session(
        "session2",
        page_url="https://example.com/app",
        tab_id="tab-123",  # Same tab
        auto_resume=True
    )

    # Should resume SDK session
    assert session2.backend.sdk_session_id == "sdk-session-abc"
    assert session2.session_id != session1.session_id  # Different WebSocket session


@pytest.mark.asyncio
async def test_different_tab_with_active_session_creates_new(session_manager):
    """Should create new session when other tab has active conversation."""
    # Create session in tab1
    session1 = await session_manager.create_session(
        "session1",
        page_url="https://example.com/app",
        tab_id="tab-123",
        auto_resume=True
    )

    # Establish SDK session
    await session_manager.update_sdk_session_id("session1", "sdk-session-abc")

    # Open same URL in different tab (tab1 still active)
    session2 = await session_manager.create_session(
        "session2",
        page_url="https://example.com/app",
        tab_id="tab-456",  # Different tab
        auto_resume=True
    )

    # Should NOT resume (other tab active)
    assert not session2.backend.has_established_session
    assert session2.backend.sdk_session_id is None


@pytest.mark.asyncio
async def test_different_tab_no_active_session_resumes(session_manager, session_store):
    """Should resume when no other tabs active, even from different tab."""
    # Create session in tab1
    session1 = await session_manager.create_session(
        "session1",
        page_url="https://example.com/app",
        tab_id="tab-123",
        auto_resume=True
    )

    # Establish SDK session
    await session_manager.update_sdk_session_id("session1", "sdk-session-abc")

    # Manually set last_activity to 25 minutes ago and mark as inactive (simulating disconnected session)
    import aiosqlite
    async with aiosqlite.connect(session_store.db_path) as db:
        await db.execute(
            "UPDATE sessions SET last_activity = ?, status = ? WHERE session_id = ?",
            ((datetime.now() - timedelta(minutes=25)).isoformat(), "inactive", "session1")
        )
        await db.commit()

    # Remove from in-memory sessions to simulate disconnect
    session_manager.sessions.pop("session1", None)

    # Open same URL in different tab (no other active tabs)
    session2 = await session_manager.create_session(
        "session2",
        page_url="https://example.com/app",
        tab_id="tab-456",  # Different tab
        auto_resume=True
    )

    # Should resume (no other tabs, within time window)
    assert session2.backend.sdk_session_id == "sdk-session-abc"


@pytest.mark.asyncio
async def test_old_session_no_resume(session_manager, session_store):
    """Should not resume session older than time window."""
    # Create session
    session1 = await session_manager.create_session(
        "session1",
        page_url="https://example.com/app",
        tab_id="tab-123",
        auto_resume=True
    )

    # Establish SDK session
    await session_manager.update_sdk_session_id("session1", "sdk-session-abc")

    # Manually set last_activity to 31 minutes ago (outside window)
    import aiosqlite
    async with aiosqlite.connect(session_store.db_path) as db:
        await db.execute(
            "UPDATE sessions SET last_activity = ? WHERE session_id = ?",
            ((datetime.now() - timedelta(minutes=31)).isoformat(), "session1")
        )
        await db.commit()

    # Remove from in-memory sessions
    await session_manager.remove_session("session1")

    # Attempt resume
    session2 = await session_manager.create_session(
        "session2",
        page_url="https://example.com/app",
        tab_id="tab-123",
        auto_resume=True
    )

    # Should NOT resume (too old)
    assert not session2.backend.has_established_session


@pytest.mark.asyncio
async def test_query_params_ignored(session_manager):
    """Query parameters should be ignored for URL matching."""
    # Create session with query params
    session1 = await session_manager.create_session(
        "session1",
        page_url="https://example.com/page?tab=settings&view=grid",
        tab_id="tab-123",
        auto_resume=True
    )

    await session_manager.update_sdk_session_id("session1", "sdk-session-abc")

    # Remove from memory (keep in DB for resume)
    session_manager.sessions.pop("session1", None)

    # Resume with different query params
    session2 = await session_manager.create_session(
        "session2",
        page_url="https://example.com/page?tab=profile",
        tab_id="tab-123",  # Same tab
        auto_resume=True
    )

    # Should resume (query params ignored)
    assert session2.backend.sdk_session_id == "sdk-session-abc"


@pytest.mark.asyncio
async def test_fragment_ignored(session_manager):
    """Fragment (#hash) should be ignored for URL matching."""
    # Create session with fragment
    session1 = await session_manager.create_session(
        "session1",
        page_url="https://example.com/page#section1",
        tab_id="tab-123",
        auto_resume=True
    )

    await session_manager.update_sdk_session_id("session1", "sdk-session-abc")
    # Remove from memory (keep in DB for resume)
    session_manager.sessions.pop("session1", None)

    # Resume with different fragment
    session2 = await session_manager.create_session(
        "session2",
        page_url="https://example.com/page#section2",
        tab_id="tab-123",
        auto_resume=True
    )

    # Should resume (fragment ignored)
    assert session2.backend.sdk_session_id == "sdk-session-abc"


@pytest.mark.asyncio
async def test_auto_resume_disabled(session_manager):
    """Should not resume when auto_resume=False."""
    # Create session
    session1 = await session_manager.create_session(
        "session1",
        page_url="https://example.com/app",
        tab_id="tab-123",
        auto_resume=True
    )

    await session_manager.update_sdk_session_id("session1", "sdk-session-abc")
    await session_manager.remove_session("session1")

    # Create new session with auto_resume=False
    session2 = await session_manager.create_session(
        "session2",
        page_url="https://example.com/app",
        tab_id="tab-123",
        auto_resume=False  # Disabled
    )

    # Should NOT resume
    assert not session2.backend.has_established_session


@pytest.mark.asyncio
async def test_no_url_no_resume(session_manager):
    """Should not resume when URL not provided."""
    # Create session
    session1 = await session_manager.create_session(
        "session1",
        page_url="https://example.com/app",
        tab_id="tab-123",
        auto_resume=True
    )

    await session_manager.update_sdk_session_id("session1", "sdk-session-abc")
    await session_manager.remove_session("session1")

    # Create new session without URL
    session2 = await session_manager.create_session(
        "session2",
        page_url=None,  # No URL
        tab_id="tab-123",
        auto_resume=True
    )

    # Should NOT resume
    assert not session2.backend.has_established_session


@pytest.mark.asyncio
async def test_no_tab_id_no_resume(session_manager):
    """Should not resume when tab_id not provided."""
    # Create session
    session1 = await session_manager.create_session(
        "session1",
        page_url="https://example.com/app",
        tab_id="tab-123",
        auto_resume=True
    )

    await session_manager.update_sdk_session_id("session1", "sdk-session-abc")
    await session_manager.remove_session("session1")

    # Create new session without tab_id
    session2 = await session_manager.create_session(
        "session2",
        page_url="https://example.com/app",
        tab_id=None,  # No tab ID
        auto_resume=True
    )

    # Should NOT resume
    assert not session2.backend.has_established_session


@pytest.mark.asyncio
async def test_session_store_methods(session_store):
    """Test session store auto-resume methods directly."""
    # Save session with URL context
    await session_store.save_session(
        session_id="test-session",
        project_path="/test",
        backend_type="claude-agent-sdk",
        permission_mode="plan",
        sdk_session_id="sdk-abc",
        page_url="https://example.com/page?tab=1",
        base_url="https://example.com/page",
        tab_id="tab-123"
    )

    # Test has_other_active_tabs (should be False - only one tab)
    has_other = await session_store.has_other_active_tabs(
        base_url="https://example.com/page",
        current_tab_id="tab-456",  # Different tab
        max_age_minutes=30
    )
    assert has_other is True  # Session from tab-123 is active

    # Test find_resumable_session
    resumable = await session_store.find_resumable_session(
        base_url="https://example.com/page",
        max_age_minutes=30
    )
    assert resumable is not None
    assert resumable['session_id'] == "test-session"
    assert resumable['sdk_session_id'] == "sdk-abc"
    assert resumable['base_url'] == "https://example.com/page"

    # Test no resumable session for different URL
    resumable = await session_store.find_resumable_session(
        base_url="https://example.com/other",
        max_age_minutes=30
    )
    assert resumable is None
