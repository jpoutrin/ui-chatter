"""Tests for immediate cancel request handling."""

import pytest
import asyncio
from unittest.mock import Mock, AsyncMock, patch
from fastapi import WebSocket

from ui_chatter.websocket import ConnectionManager
from ui_chatter.stream_controller import StreamController


@pytest.mark.asyncio
async def test_cancel_request_immediate_handling():
    """Cancel request should be handled immediately in receiver loop, not queued."""
    # Setup
    stream_controller = StreamController()
    connection_manager = ConnectionManager(
        max_connections=100,
        ping_interval=20,
        ping_timeout=10,
        stream_controller=stream_controller
    )

    # Create a stream
    stream_id = "test-stream-123"
    cancel_event = stream_controller.create_stream(stream_id)

    # Verify stream was created
    assert cancel_event is not None
    assert not cancel_event.is_set()

    # Mock WebSocket
    websocket = Mock(spec=WebSocket)
    websocket.headers = {"origin": "chrome-extension://test"}
    websocket.accept = AsyncMock()
    websocket.receive_json = AsyncMock()
    websocket.send_json = AsyncMock()

    session_id = "test-session"

    # Connect
    await connection_manager.connect(session_id, websocket)

    # Start receiver task
    connection_manager.start_receiver(session_id, websocket, receive_timeout=5)

    # Simulate cancel_request message
    cancel_request = {
        "type": "cancel_request",
        "stream_id": stream_id
    }

    # Setup websocket to return cancel_request once, then timeout
    async def mock_receive():
        await asyncio.sleep(0.1)  # Small delay to simulate network
        return cancel_request

    websocket.receive_json.side_effect = mock_receive

    # Wait a bit for receiver to process
    await asyncio.sleep(0.2)

    # Verify cancel_event was set (immediate handling)
    assert cancel_event.is_set(), "Cancel event should be set immediately"

    # Verify acknowledgment was sent directly (not queued)
    websocket.send_json.assert_called_once()
    sent_message = websocket.send_json.call_args[0][0]
    assert sent_message["type"] == "status"
    assert sent_message["status"] == "cancelled"

    # Verify message was NOT queued
    queue = connection_manager.message_queues.get(session_id)
    assert queue is not None
    assert queue.empty(), "Cancel request should not be queued"

    # Cleanup
    connection_manager.disconnect(session_id)
    stream_controller.cleanup_stream(stream_id)


@pytest.mark.asyncio
async def test_pong_still_handled_immediately():
    """Verify pong messages are still handled immediately (regression test)."""
    # Setup
    stream_controller = StreamController()
    connection_manager = ConnectionManager(
        max_connections=100,
        stream_controller=stream_controller
    )

    # Mock WebSocket
    websocket = Mock(spec=WebSocket)
    websocket.headers = {"origin": "chrome-extension://test"}
    websocket.accept = AsyncMock()
    websocket.send_json = AsyncMock()

    session_id = "test-session"

    # Connect
    await connection_manager.connect(session_id, websocket)

    # Start receiver
    connection_manager.start_receiver(session_id, websocket, receive_timeout=5)

    # Simulate pong message
    pong_message = {"type": "pong"}

    async def mock_receive():
        await asyncio.sleep(0.05)
        return pong_message

    websocket.receive_json = AsyncMock(side_effect=mock_receive)

    # Create pong event for tracking
    pong_event = asyncio.Event()
    connection_manager.pong_events[session_id] = pong_event

    # Wait for receiver to process
    await asyncio.sleep(0.1)

    # Verify pong was marked as received (immediate handling)
    assert session_id in connection_manager.last_pong_time

    # Verify pong was NOT queued
    queue = connection_manager.message_queues.get(session_id)
    assert queue is not None
    assert queue.empty(), "Pong should not be queued"

    # Cleanup
    connection_manager.disconnect(session_id)


@pytest.mark.asyncio
async def test_other_messages_still_queued():
    """Verify other message types are still queued correctly (regression test)."""
    # Setup
    stream_controller = StreamController()
    connection_manager = ConnectionManager(
        max_connections=100,
        stream_controller=stream_controller
    )

    # Mock WebSocket
    websocket = Mock(spec=WebSocket)
    websocket.headers = {"origin": "chrome-extension://test"}
    websocket.accept = AsyncMock()

    session_id = "test-session"

    # Connect
    await connection_manager.connect(session_id, websocket)

    # Start receiver
    connection_manager.start_receiver(session_id, websocket, receive_timeout=5)

    # Simulate chat message
    chat_message = {
        "type": "chat",
        "message": "Hello",
        "context": {}
    }

    async def mock_receive():
        await asyncio.sleep(0.05)
        return chat_message

    websocket.receive_json = AsyncMock(side_effect=mock_receive)

    # Wait for receiver to process
    await asyncio.sleep(0.1)

    # Verify chat message WAS queued (normal behavior)
    queue = connection_manager.message_queues.get(session_id)
    assert queue is not None

    # Get message from queue with timeout
    try:
        received = await asyncio.wait_for(queue.get(), timeout=0.5)
        assert received == chat_message, "Chat message should be queued"
    except asyncio.TimeoutError:
        pytest.fail("Chat message was not queued")

    # Cleanup
    connection_manager.disconnect(session_id)


@pytest.mark.asyncio
async def test_cancel_without_stream_controller():
    """Verify graceful handling when stream_controller is None."""
    # Setup without stream_controller
    connection_manager = ConnectionManager(
        max_connections=100,
        stream_controller=None  # No controller
    )

    # Mock WebSocket
    websocket = Mock(spec=WebSocket)
    websocket.headers = {"origin": "chrome-extension://test"}
    websocket.accept = AsyncMock()
    websocket.send_json = AsyncMock()

    session_id = "test-session"

    # Connect
    await connection_manager.connect(session_id, websocket)

    # Start receiver
    connection_manager.start_receiver(session_id, websocket, receive_timeout=5)

    # Simulate cancel_request
    cancel_request = {
        "type": "cancel_request",
        "stream_id": "test-stream"
    }

    async def mock_receive():
        await asyncio.sleep(0.05)
        return cancel_request

    websocket.receive_json = AsyncMock(side_effect=mock_receive)

    # Wait for receiver to process
    await asyncio.sleep(0.1)

    # Verify no error occurred (graceful handling)
    # Message should NOT be queued
    queue = connection_manager.message_queues.get(session_id)
    assert queue is not None
    assert queue.empty(), "Cancel request should not be queued even without controller"

    # Cleanup
    connection_manager.disconnect(session_id)
