# TS-0006: SDK Streaming and UX Improvements

**Status**: DRAFT
**Tech Spec ID**: TS-0006
**Title**: Claude Agent SDK Streaming Protocol and UX Enhancements
**Created**: 2026-01-30
**Last Updated**: 2026-01-30
**Author**: [To be filled]
**Decision Reference**: None
**Implements RFC**: None
**Related Specs**: TS-0003, TS-0005

---

## Executive Summary

### Problem Statement

The current UI Chatter implementation successfully integrates the Claude Agent SDK (TS-0005) but provides poor user experience due to:

1. **Invisible Tool Execution**: Backend discards all `ToolUseBlock` messages, preventing users from seeing which files Claude reads/writes or what commands execute
2. **No User Control**: Users cannot cancel long-running operations or interrupt unwanted changes
3. **Poor Information Hierarchy**: Responses are rendered as unformatted "wall of text" with no markdown, code highlighting, or structure
4. **Lack of Feedback**: No streaming indicators, progress tracking, or real-time status updates during execution

### Proposed Solution

Implement a **multi-channel streaming protocol** that separates text responses, tool execution events, and control messages. Enhance the frontend with:
- Real-time tool execution visibility panel
- Stop/cancel button for streaming operations
- Markdown rendering with syntax highlighting
- Visual message type hierarchy
- Progressive disclosure for long responses

### Success Metrics

| Metric | Current | Target |
|--------|---------|--------|
| Tool execution visibility | 0% (hidden) | 100% |
| Cancellation success rate | 0% (no button) | 95% |
| Message readability score | 3/10 (plain text) | 8/10 |
| Time to understand system state | Unknown | < 3s |
| WCAG AA compliance | Unknown | 100% |

### Scope

**In Scope:**
- Multi-channel streaming protocol (response chunks, tool activity, stream control)
- Backend tool execution tracking and cancellation
- Frontend tool visibility panel and stop button
- Markdown rendering and syntax highlighting
- Message type hierarchy and visual design
- Stream state management

**Out of Scope:**
- Permission mode UI (covered by TS-0003)
- Session management (covered by TS-0004)
- Screenshot handling
- Multi-turn conversation history
- Agent response caching

---

## Architecture Overview

### Current Architecture Issues

```
┌────────────────────────────────────────────────────────────┐
│                    CURRENT FLOW (BROKEN)                   │
└────────────────────────────────────────────────────────────┘

Claude Agent SDK         Backend             Frontend
─────────────────        ───────             ────────

AssistantMessage  ──►   Extract              Display
  └─ TextBlock    ──►   text only     ──►   as plain text
  └─ ToolUseBlock ──►   DISCARDED!    ──►   (never shown)

ResultMessage     ──►   Send "done"   ──►   No summary
                                            or metrics
```

**Critical Issue**: `claude_agent_sdk.py:168-172` silently discards tool activity:
```python
elif block_type == "ToolUseBlock":
    logger.debug(f"[AGENT SDK] Skipping ToolUseBlock (tool: {block.name})")
    continue  # <-- USER NEVER SEES THIS
```

### Proposed Architecture

```
┌────────────────────────────────────────────────────────────┐
│                 PROPOSED MULTI-CHANNEL FLOW                │
└────────────────────────────────────────────────────────────┘

Claude Agent SDK         Backend                    Frontend
─────────────────        ───────                    ────────

Stream Start      ──►   emit stream_control    ──►  Show "Connecting..."
                       (action: "started")

AssistantMessage
  └─ TextBlock    ──►   emit response_chunk    ──►  Append markdown text
  └─ ToolUseBlock ──►   emit tool_activity     ──►  Show "Read Login.tsx"
                       (status: "executing")

ToolResultMessage ──►   emit tool_activity     ──►  Update "✓ Completed 234ms"
                       (status: "completed")

ResultMessage     ──►   emit stream_control    ──►  Hide indicators
                       (action: "completed")        Show metrics
```

### Component Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                         FRONTEND COMPONENTS                       │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ Connection Status Bar                                     │  │
│  │ ● Connected  |  Session: main-session                     │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ Messages Container (role="log" aria-live="polite")        │  │
│  │                                                            │  │
│  │  [User]    "Analyze this button component"                │  │
│  │                                                            │  │
│  │  [Tool Activity Panel]                                    │  │
│  │  ⚙️ Claude is working...                   [Cancel]       │  │
│  │  ✓ Read   src/components/Button.tsx        234ms         │  │
│  │  ◐ Grep   pattern: "className" in *.tsx   (executing)    │  │
│  │  ○ Read   src/styles/button.css           (pending)      │  │
│  │                                                            │  │
│  │  [Assistant] (markdown-rendered)                          │  │
│  │  ## Component Analysis                                    │  │
│  │  The button uses **DaisyUI** with:                        │  │
│  │  ```typescript                                            │  │
│  │  <button className="btn btn-primary">...</button>         │  │
│  │  ```                                                       │  │
│  │  [Show more]                                              │  │
│  │                                                            │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ Input Area                                                │  │
│  │ [Select Element] [Message input...............] [Send]   │  │
│  │                                      [Stop]               │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
         │                                  ▲
         │ WebSocket                        │ WebSocket
         │ (send_chat, cancel_request)      │ (multi-channel msgs)
         ▼                                  │
┌──────────────────────────────────────────────────────────────────┐
│                       BACKEND COMPONENTS                          │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│  WebSocket Handler (/ws)                                         │
│    ├─ handle_chat(message)                                       │
│    ├─ handle_cancel_request(session_id)                          │
│    └─ send_json(multi_channel_message)                           │
│                                                                   │
│  StreamController                                                │
│    ├─ create_stream(stream_id) → cancel_event                    │
│    ├─ cancel_stream(stream_id) → bool                            │
│    └─ cleanup_stream(stream_id)                                  │
│                                                                   │
│  ClaudeAgentSDKBackend                                           │
│    ├─ handle_chat() → AsyncGenerator[dict]                       │
│    │   ├─ yields: stream_control (started)                       │
│    │   ├─ yields: response_chunk (text)                          │
│    │   ├─ yields: tool_activity (executing/completed)            │
│    │   └─ yields: stream_control (completed)                     │
│    │                                                              │
│    ├─ _extract_tool_activity(ToolUseBlock) → dict                │
│    ├─ _summarize_tool_input(input) → str                         │
│    └─ check_cancellation(cancel_event) → bool                    │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
         │                                  ▲
         │ query()                          │ async generator
         ▼                                  │
┌──────────────────────────────────────────────────────────────────┐
│                   CLAUDE AGENT SDK (External)                     │
│  query(prompt, options) → AsyncGenerator[Message]                │
│    ├─ AssistantMessage (content: [TextBlock, ToolUseBlock])      │
│    ├─ ToolResultMessage (is_error, content)                      │
│    └─ ResultMessage (done: True)                                 │
└──────────────────────────────────────────────────────────────────┘
```

---

## Design Details

### 1. Multi-Channel Streaming Protocol

#### Message Types

```python
# service/src/ui_chatter/models/messages.py

from enum import Enum
from typing import Literal, Optional, Dict, Any
from datetime import datetime
from pydantic import BaseModel, Field

class MessageType(str, Enum):
    """WebSocket message types."""
    RESPONSE_CHUNK = "response_chunk"
    TOOL_ACTIVITY = "tool_activity"
    STREAM_CONTROL = "stream_control"
    STATUS = "status"
    ERROR = "error"

class ResponseChunk(BaseModel):
    """Text content from Claude's response."""
    type: Literal["response_chunk"] = "response_chunk"
    content: str = Field(..., description="Text content to display")
    chunk_id: Optional[str] = Field(None, description="Unique chunk identifier")
    done: bool = Field(False, description="Whether this is the final chunk")

class ToolActivityStatus(str, Enum):
    PENDING = "pending"
    EXECUTING = "executing"
    COMPLETED = "completed"
    FAILED = "failed"

class ToolActivity(BaseModel):
    """Real-time tool execution tracking."""
    type: Literal["tool_activity"] = "tool_activity"
    tool_id: str = Field(..., description="Unique identifier for this tool call")
    tool_name: str = Field(..., description="Tool name (Read, Write, Edit, Bash, etc.)")
    status: ToolActivityStatus
    input_summary: Optional[str] = Field(None, description="Abbreviated tool input")
    output_summary: Optional[str] = Field(None, description="Abbreviated tool output")
    duration_ms: Optional[int] = Field(None, description="Execution time in milliseconds")
    timestamp: datetime = Field(default_factory=datetime.utcnow)

class StreamControlAction(str, Enum):
    STARTED = "started"
    PAUSED = "paused"
    RESUMED = "resumed"
    CANCELLED = "cancelled"
    COMPLETED = "completed"

class StreamControl(BaseModel):
    """Stream lifecycle control."""
    type: Literal["stream_control"] = "stream_control"
    action: StreamControlAction
    stream_id: str = Field(..., description="Unique stream session identifier")
    reason: Optional[str] = Field(None, description="Reason for state change")
    metadata: Optional[Dict[str, Any]] = Field(None, description="Additional context")
```

#### Protocol Flow

```
┌──────────────────────────────────────────────────────────────────┐
│                    MESSAGE SEQUENCE DIAGRAM                       │
└──────────────────────────────────────────────────────────────────┘

Frontend              Backend              Claude SDK
────────              ───────              ──────────

send_chat  ────────►
                     stream_control
                     (action: started)  ─►

                                           AssistantMessage
                     ◄──────────────────  └─ TextBlock
                     response_chunk
                     (content: "I'll...")  ─►

                                           AssistantMessage
                     ◄──────────────────  └─ ToolUseBlock
                     tool_activity            (name: "Read")
                     (status: executing) ─►

                                           ToolResultMessage
                     ◄──────────────────  (content: "...")
                     tool_activity
                     (status: completed) ─►

                                           AssistantMessage
                     ◄──────────────────  └─ TextBlock
                     response_chunk
                     (content: "file has") ─►

                                           ResultMessage
                     ◄──────────────────  (done: True)
                     stream_control
                     (action: completed) ─►
```

### 2. Backend Implementation

#### Stream Controller

```python
# service/src/ui_chatter/stream_controller.py

import asyncio
from typing import Dict, Optional
from datetime import datetime
import logging

logger = logging.getLogger(__name__)

class StreamController:
    """
    Manages streaming state and cancellation for active sessions.

    Each stream has:
    - Unique stream_id
    - Cancellation event for graceful shutdown
    - State tracking (streaming, cancelling, completed)
    - Creation timestamp for timeout detection
    """

    def __init__(self):
        self._streams: Dict[str, asyncio.Event] = {}
        self._states: Dict[str, str] = {}
        self._timestamps: Dict[str, datetime] = {}

    def create_stream(self, stream_id: str) -> asyncio.Event:
        """
        Create a new stream with cancellation support.

        Args:
            stream_id: Unique identifier for this stream

        Returns:
            asyncio.Event that will be set when cancellation requested
        """
        cancel_event = asyncio.Event()
        self._streams[stream_id] = cancel_event
        self._states[stream_id] = "streaming"
        self._timestamps[stream_id] = datetime.utcnow()

        logger.info(f"Created stream {stream_id}")
        return cancel_event

    def cancel_stream(self, stream_id: str) -> bool:
        """
        Request cancellation of an active stream.

        Args:
            stream_id: Stream to cancel

        Returns:
            True if stream exists and cancellation requested
        """
        if stream_id in self._streams:
            self._streams[stream_id].set()
            self._states[stream_id] = "cancelling"
            logger.info(f"Cancelled stream {stream_id}")
            return True

        logger.warning(f"Cannot cancel stream {stream_id}: not found")
        return False

    def get_state(self, stream_id: str) -> Optional[str]:
        """Get current state of stream."""
        return self._states.get(stream_id)

    def cleanup_stream(self, stream_id: str):
        """Remove stream state after completion."""
        self._streams.pop(stream_id, None)
        self._states.pop(stream_id, None)
        self._timestamps.pop(stream_id, None)
        logger.info(f"Cleaned up stream {stream_id}")

    def list_active_streams(self) -> Dict[str, dict]:
        """Return all active streams with metadata."""
        return {
            stream_id: {
                "state": self._states.get(stream_id),
                "created": self._timestamps.get(stream_id).isoformat(),
                "cancelled": self._streams[stream_id].is_set()
            }
            for stream_id in self._streams
        }
```

#### Backend Changes

```python
# service/src/ui_chatter/backends/claude_agent_sdk.py

import uuid
import time
from typing import AsyncGenerator, Optional

from .base import AgentBackend
from ..models.messages import (
    ResponseChunk, ToolActivity, ToolActivityStatus,
    StreamControl, StreamControlAction
)

class ClaudeAgentSDKBackend(AgentBackend):

    async def handle_chat(
        self,
        context: CapturedContext,
        message: str,
        is_first_message: bool = False,
        screenshot_path: Optional[str] = None,
        cancel_event: Optional[asyncio.Event] = None,
    ) -> AsyncGenerator[dict, None]:
        """
        Stream response with multi-channel protocol.

        Yields:
            - StreamControl: Stream lifecycle events
            - ResponseChunk: Text content
            - ToolActivity: Tool execution tracking
        """
        stream_id = str(uuid.uuid4())
        start_time = time.time()
        tool_count = 0

        try:
            # Signal stream start
            yield StreamControl(
                action=StreamControlAction.STARTED,
                stream_id=stream_id
            ).model_dump()

            prompt = self._build_prompt(context, message, screenshot_path)

            async for msg in query(
                prompt=prompt,
                options=ClaudeAgentOptions(
                    allowed_tools=self.allowed_tools,
                    permission_mode=self.permission_mode,
                )
            ):
                # Check for cancellation
                if cancel_event and cancel_event.is_set():
                    yield StreamControl(
                        action=StreamControlAction.CANCELLED,
                        stream_id=stream_id,
                        reason="user_request"
                    ).model_dump()
                    return

                msg_type = type(msg).__name__

                if msg_type == "AssistantMessage":
                    # Process content blocks
                    for block in msg.content:
                        block_type = block.__class__.__name__

                        if block_type == "TextBlock":
                            # Yield text content
                            yield ResponseChunk(
                                content=block.text,
                                done=False
                            ).model_dump()

                        elif block_type == "ToolUseBlock":
                            # NEW: Track tool execution
                            tool_count += 1
                            yield ToolActivity(
                                tool_id=block.id,
                                tool_name=block.name,
                                status=ToolActivityStatus.EXECUTING,
                                input_summary=self._summarize_tool_input(
                                    block.name, block.input
                                ),
                            ).model_dump()

                elif msg_type == "ToolResultMessage":
                    # Track tool completion
                    yield ToolActivity(
                        tool_id=msg.tool_use_id,
                        tool_name="",  # SDK doesn't provide tool name in result
                        status=(
                            ToolActivityStatus.FAILED
                            if msg.is_error
                            else ToolActivityStatus.COMPLETED
                        ),
                        output_summary=self._summarize_tool_output(msg.content),
                    ).model_dump()

                elif msg_type == "ResultMessage":
                    # Final message
                    duration_ms = int((time.time() - start_time) * 1000)

                    yield ResponseChunk(
                        content="",
                        done=True
                    ).model_dump()

                    yield StreamControl(
                        action=StreamControlAction.COMPLETED,
                        stream_id=stream_id,
                        metadata={
                            "duration_ms": duration_ms,
                            "tools_used": tool_count
                        }
                    ).model_dump()

        except asyncio.CancelledError:
            yield StreamControl(
                action=StreamControlAction.CANCELLED,
                stream_id=stream_id,
                reason="task_cancelled"
            ).model_dump()

        except Exception as e:
            logger.error(f"Chat error: {e}", exc_info=True)
            yield {
                "type": "error",
                "code": self._classify_error(e),
                "message": self._get_error_message(self._classify_error(e), e)
            }

    def _summarize_tool_input(self, tool_name: str, input_dict: dict) -> str:
        """Create human-readable summary of tool input."""
        if tool_name == "Read":
            return f"Reading {input_dict.get('file_path', 'file')}"
        elif tool_name == "Write":
            return f"Writing {input_dict.get('file_path', 'file')}"
        elif tool_name == "Edit":
            return f"Editing {input_dict.get('file_path', 'file')}"
        elif tool_name == "Bash":
            cmd = input_dict.get('command', '')
            return f"Running: {cmd[:50]}{'...' if len(cmd) > 50 else ''}"
        elif tool_name == "Grep":
            return f"Searching for \"{input_dict.get('pattern', '')}\""
        else:
            return f"{tool_name} operation"

    def _summarize_tool_output(self, content: list) -> Optional[str]:
        """Create abbreviated summary of tool output."""
        if not content:
            return None

        # Tool results come as content blocks
        text_parts = []
        for block in content:
            if hasattr(block, 'text'):
                text = block.text
                if len(text) > 100:
                    text_parts.append(text[:100] + "...")
                else:
                    text_parts.append(text)

        return " ".join(text_parts) if text_parts else None
```

#### WebSocket Handler Changes

```python
# service/src/ui_chatter/websocket.py

from .stream_controller import StreamController

class WebSocketHandler:

    def __init__(self):
        self.stream_controller = StreamController()
        # ... existing init

    async def handle_websocket(self, websocket: WebSocket):
        # ... existing code

        # Handle new message types
        if message_type == "cancel_request":
            stream_id = data.get("stream_id")
            if stream_id:
                success = self.stream_controller.cancel_stream(stream_id)
                await websocket.send_json({
                    "type": "status",
                    "status": "cancelled" if success else "error",
                    "detail": "Stream cancelled" if success else "Stream not found"
                })

    async def chat_handler(self, session_id: str, message: str, context: dict):
        """Modified chat handler with cancellation support."""
        session = self.session_manager.get_session(session_id)

        # Create stream with cancellation event
        stream_id = str(uuid.uuid4())
        cancel_event = self.stream_controller.create_stream(stream_id)

        try:
            async for response in session.backend.handle_chat(
                context=context,
                message=message,
                cancel_event=cancel_event
            ):
                # Send multi-channel messages to frontend
                await self.websocket.send_json(response)
        finally:
            self.stream_controller.cleanup_stream(stream_id)
```

### 3. Frontend Implementation

#### Message Handler

```javascript
// poc/extension/sidepanel.js

const MessageType = {
  RESPONSE_CHUNK: 'response_chunk',
  TOOL_ACTIVITY: 'tool_activity',
  STREAM_CONTROL: 'stream_control',
  STATUS: 'status',
  ERROR: 'error'
};

const ToolActivityStatus = {
  PENDING: 'pending',
  EXECUTING: 'executing',
  COMPLETED: 'completed',
  FAILED: 'failed'
};

// Track active tools
const activeTools = new Map();
let activeToolPanel = null;
let currentStreamId = null;

function handleServerMessage(message) {
  const { type } = message;

  switch(type) {
    case MessageType.STREAM_CONTROL:
      handleStreamControl(message);
      break;

    case MessageType.RESPONSE_CHUNK:
      handleResponseChunk(message);
      break;

    case MessageType.TOOL_ACTIVITY:
      handleToolActivity(message);
      break;

    case MessageType.STATUS:
      handleStatus(message);
      break;

    case MessageType.ERROR:
      handleError(message);
      break;
  }
}

function handleStreamControl(message) {
  const { action, stream_id, metadata } = message;

  switch(action) {
    case 'started':
      currentStreamId = stream_id;
      showStreamingUI();
      break;

    case 'completed':
      hideStreamingUI();
      if (metadata) {
        showCompletionMetrics(metadata);
      }
      break;

    case 'cancelled':
      hideStreamingUI();
      addMessage('status', '⏹ Request cancelled');
      break;
  }
}

function handleToolActivity(message) {
  const { tool_id, tool_name, status, input_summary, duration_ms } = message;

  // Update tool map
  activeTools.set(tool_id, {
    name: tool_name,
    status,
    input: input_summary,
    duration: duration_ms,
    timestamp: Date.now()
  });

  // Render tool panel
  renderToolActivityPanel();
}

function showStreamingUI() {
  // Show stop button, hide send button
  elements.sendBtn.style.display = 'none';
  elements.stopBtn.style.display = 'inline-block';
  elements.messageInput.disabled = true;

  // Show thinking indicator
  const indicator = document.getElementById('thinkingIndicator');
  indicator.style.display = 'flex';
}

function hideStreamingUI() {
  // Hide stop button, show send button
  elements.stopBtn.style.display = 'none';
  elements.sendBtn.style.display = 'inline-block';
  elements.messageInput.disabled = false;
  elements.messageInput.focus();

  // Hide thinking indicator
  const indicator = document.getElementById('thinkingIndicator');
  indicator.style.display = 'none';

  // Remove tool panel after fade
  if (activeToolPanel) {
    activeToolPanel.style.opacity = '0.5';
    setTimeout(() => {
      activeToolPanel.remove();
      activeToolPanel = null;
      activeTools.clear();
    }, 500);
  }
}

function cancelStream() {
  if (currentStreamId) {
    chrome.runtime.sendMessage({
      type: 'cancel_request',
      stream_id: currentStreamId
    });

    addMessage('status', 'Cancelling request...');
  }
}

function renderToolActivityPanel() {
  if (!activeToolPanel) {
    activeToolPanel = document.createElement('div');
    activeToolPanel.className = 'tool-activity-panel';
    elements.messages.appendChild(activeToolPanel);
  }

  const tools = Array.from(activeTools.values());
  const completed = tools.filter(t => t.status === 'completed').length;
  const executing = tools.filter(t => t.status === 'executing').length;
  const pending = tools.filter(t => t.status === 'pending').length;
  const failed = tools.filter(t => t.status === 'failed').length;

  activeToolPanel.innerHTML = `
    <div class="tool-panel-header">
      <span class="tool-icon">⚙️</span>
      <span>Claude is working...</span>
      <button class="cancel-btn" onclick="cancelStream()">Cancel</button>
    </div>
    <div class="tool-list">
      ${tools.map(t => `
        <div class="tool-item tool-${t.status}">
          <span class="tool-status">${getStatusIcon(t.status)}</span>
          <span class="tool-name">${t.name}</span>
          <span class="tool-input">${truncate(t.input || '', 40)}</span>
          <span class="tool-duration">${t.duration ? t.duration + 'ms' : ''}</span>
        </div>
      `).join('')}
    </div>
    <div class="tool-summary">
      ${completed} completed${failed > 0 ? `, ${failed} failed` : ''}${executing > 0 ? `, ${executing} in progress` : ''}${pending > 0 ? `, ${pending} pending` : ''}
    </div>
  `;

  // Auto-scroll to keep visible
  activeToolPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function getStatusIcon(status) {
  const icons = {
    'completed': '✓',
    'executing': '◐',
    'pending': '○',
    'failed': '✗'
  };
  return icons[status] || '?';
}

function truncate(str, maxLength) {
  return str.length > maxLength ? str.substring(0, maxLength) + '...' : str;
}
```

#### Markdown Rendering

```javascript
// Add marked.js and DOMPurify for safe markdown rendering

function handleResponseChunk(message) {
  const { content, done } = message;

  if (!lastAssistantMessage || lastAssistantMessage.className !== 'message assistant') {
    lastAssistantMessage = addMessage('assistant', '');
    lastAssistantMessage.dataset.rawContent = '';
  }

  // Accumulate raw markdown content
  lastAssistantMessage.dataset.rawContent += content;

  // Parse and render markdown
  const parsed = marked.parse(lastAssistantMessage.dataset.rawContent);
  const sanitized = DOMPurify.sanitize(parsed);
  lastAssistantMessage.innerHTML = sanitized;

  // Apply syntax highlighting to code blocks
  lastAssistantMessage.querySelectorAll('pre code').forEach(block => {
    // Auto-detect language or use specified class
    if (!block.classList.length) {
      Prism.highlightElement(block);
    }
  });

  // Add expand/collapse for long messages
  if (done) {
    addExpandToggleIfNeeded(lastAssistantMessage);
  }

  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function addExpandToggleIfNeeded(messageDiv) {
  if (messageDiv.scrollHeight > 400) {
    messageDiv.classList.add('truncated');

    const toggle = document.createElement('button');
    toggle.className = 'expand-toggle';
    toggle.textContent = 'Show more';
    toggle.onclick = () => {
      messageDiv.classList.toggle('expanded');
      toggle.textContent = messageDiv.classList.contains('expanded')
        ? 'Show less'
        : 'Show more';
    };

    messageDiv.appendChild(toggle);
  }
}
```

#### HTML Structure

```html
<!-- poc/extension/sidepanel.html -->

<!-- Add external libraries -->
<script src="https://cdn.jsdelivr.net/npm/marked@11.1.1/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/dompurify@3.0.8/dist/purify.min.js"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/themes/prism.min.css">
<script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/prism.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-typescript.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-python.min.js"></script>

<!-- Add thinking indicator -->
<div class="thinking-indicator" id="thinkingIndicator" style="display: none;">
  <div class="thinking-dots">
    <span></span><span></span><span></span>
  </div>
  <span class="thinking-text">Claude is thinking...</span>
</div>

<!-- Update input area with stop button -->
<div class="input-area" id="inputArea">
  <button class="btn btn-secondary" id="selectBtn">
    <span class="icon">🎯</span> Select Element
  </button>
  <input type="text" id="messageInput" placeholder="Ask Claude about the selected element..." disabled />
  <button class="btn btn-danger" id="stopBtn" style="display: none;" onclick="cancelStream()">
    <span class="icon">⏹</span> Stop
  </button>
  <button class="btn btn-primary" id="sendBtn" disabled>
    <span class="icon">➤</span> Send
  </button>
</div>
```

#### CSS Styles

```css
/* Tool Activity Panel */
.tool-activity-panel {
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  border-left: 4px solid #3b82f6;
  border-radius: 8px;
  padding: 12px 16px;
  margin: 12px 0;
  font-size: 13px;
}

.tool-panel-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  font-weight: 600;
  color: #1e40af;
}

.tool-icon {
  font-size: 16px;
}

.cancel-btn {
  margin-left: auto;
  padding: 4px 12px;
  background: #ef4444;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}

.cancel-btn:hover {
  background: #dc2626;
}

.tool-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 8px;
}

.tool-item {
  display: grid;
  grid-template-columns: 20px 60px 1fr 60px;
  gap: 8px;
  align-items: center;
  padding: 6px;
  background: white;
  border-radius: 4px;
  font-size: 12px;
}

.tool-item.tool-executing {
  border-left: 3px solid #3b82f6;
}

.tool-item.tool-completed {
  border-left: 3px solid #10b981;
}

.tool-item.tool-failed {
  border-left: 3px solid #ef4444;
}

.tool-status {
  font-size: 14px;
}

.tool-name {
  font-weight: 600;
  color: #374151;
}

.tool-input {
  font-family: 'Courier New', monospace;
  color: #6b7280;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-duration {
  text-align: right;
  color: #9ca3af;
  font-size: 11px;
}

.tool-summary {
  padding-top: 8px;
  border-top: 1px solid #bfdbfe;
  font-size: 11px;
  color: #6b7280;
}

/* Thinking Indicator */
.thinking-indicator {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: #f9fafb;
  border-radius: 8px;
  margin: 12px 0;
}

.thinking-dots {
  display: flex;
  gap: 6px;
}

.thinking-dots span {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #6b7280;
  animation: thinking-pulse 1.4s infinite ease-in-out;
}

.thinking-dots span:nth-child(1) { animation-delay: 0s; }
.thinking-dots span:nth-child(2) { animation-delay: 0.2s; }
.thinking-dots span:nth-child(3) { animation-delay: 0.4s; }

@keyframes thinking-pulse {
  0%, 60%, 100% {
    transform: scale(1);
    opacity: 0.5;
  }
  30% {
    transform: scale(1.3);
    opacity: 1;
  }
}

.thinking-text {
  font-size: 14px;
  color: #6b7280;
  font-style: italic;
}

/* Message Type Hierarchy */
.message {
  margin-bottom: 16px;
  padding: 12px 16px;
  border-radius: 8px;
  position: relative;
}

.message-timestamp {
  font-size: 11px;
  color: #9ca3af;
  margin-bottom: 4px;
}

.message.user {
  background: #dbeafe;
  border-left: 3px solid #3b82f6;
  margin-left: 20%;
}

.message.assistant {
  background: white;
  border: 1px solid #e5e7eb;
  border-left: 3px solid #10b981;
  max-height: 400px;
  overflow: hidden;
  transition: max-height 0.3s ease;
}

.message.assistant.expanded {
  max-height: none;
}

.message.assistant.truncated::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 60px;
  background: linear-gradient(transparent, white);
  pointer-events: none;
}

.expand-toggle {
  display: block;
  margin-top: 8px;
  padding: 6px 12px;
  background: #f3f4f6;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  color: #374151;
}

.expand-toggle:hover {
  background: #e5e7eb;
}

/* Code Blocks */
.message pre {
  background: #1f2937;
  color: #e5e7eb;
  padding: 12px;
  border-radius: 6px;
  overflow-x: auto;
  margin: 12px 0;
}

.message code {
  font-family: 'Courier New', Monaco, monospace;
  font-size: 13px;
}

/* Stop Button */
.btn-danger {
  background: #ef4444;
  color: white;
}

.btn-danger:hover {
  background: #dc2626;
}

.btn .icon {
  display: inline-block;
  margin-right: 4px;
}

/* Keyboard Focus Indicators */
*:focus {
  outline: 2px solid #3b82f6;
  outline-offset: 2px;
}

.btn:focus {
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.3);
}
```

---

## API Specifications

### WebSocket Message Types

#### 1. Client → Server

```typescript
// User sends a chat message
{
  type: "send_chat",
  session_id: string,
  message: string,
  context: CapturedContext
}

// User requests cancellation
{
  type: "cancel_request",
  session_id: string,
  stream_id: string
}
```

#### 2. Server → Client

```typescript
// Stream lifecycle control
{
  type: "stream_control",
  action: "started" | "paused" | "resumed" | "cancelled" | "completed",
  stream_id: string,
  reason?: string,
  metadata?: {
    duration_ms?: number,
    tools_used?: number,
    [key: string]: any
  }
}

// Text response chunks
{
  type: "response_chunk",
  content: string,
  chunk_id?: string,
  done: boolean
}

// Tool execution tracking
{
  type: "tool_activity",
  tool_id: string,
  tool_name: string,
  status: "pending" | "executing" | "completed" | "failed",
  input_summary?: string,
  output_summary?: string,
  duration_ms?: number,
  timestamp: string  // ISO 8601
}

// Status updates
{
  type: "status",
  status: "idle" | "thinking" | "executing" | "done" | "error",
  detail?: string
}

// Error messages
{
  type: "error",
  code: string,
  message: string
}
```

---

## Data Models

### Tool Activity Lifecycle

```
┌──────────────────────────────────────────────────────────────────┐
│                    TOOL ACTIVITY STATES                           │
└──────────────────────────────────────────────────────────────────┘

   ┌─────────┐
   │ PENDING │  Tool queued but not yet started
   └────┬────┘
        │ SDK sends ToolUseBlock
        ▼
   ┌──────────┐
   │EXECUTING │  Tool is actively running
   └────┬────┘
        │ SDK sends ToolResultMessage
        ▼
   ┌──────────┐    ┌────────┐
   │COMPLETED │ or │ FAILED │
   └──────────┘    └────────┘
```

### Stream State Machine

```
   ┌──────┐
   │ IDLE │  No active stream
   └───┬──┘
       │ User sends message
       ▼
   ┌───────────┐
   │ STREAMING │  Receiving chunks
   └─┬──┬──┬───┘
     │  │  │
     │  │  │ SDK completes
     │  │  ▼
     │  │ ┌───────────┐
     │  │ │ COMPLETED │
     │  │ └───────────┘
     │  │
     │  │ User cancels
     │  ▼
     │ ┌────────────┐
     │ │ CANCELLING │
     │ └──────┬─────┘
     │        │
     │        ▼
     │   ┌──────────┐
     │   │ CANCELLED│
     │   └──────────┘
     │
     │ Error occurs
     ▼
   ┌───────┐
   │ ERROR │
   └───────┘
```

---

## Security Considerations

### 1. WebSocket Message Validation

**Risk**: Malicious messages could trigger unintended actions.

**Mitigation**:
- Validate all incoming message types against whitelist
- Sanitize stream_id and session_id parameters
- Rate limit cancel requests to prevent abuse

```python
# service/src/ui_chatter/websocket.py

ALLOWED_MESSAGE_TYPES = {
    "send_chat", "cancel_request", "ping"
}

def validate_message(message: dict) -> bool:
    """Validate incoming WebSocket message."""
    msg_type = message.get("type")

    if msg_type not in ALLOWED_MESSAGE_TYPES:
        logger.warning(f"Invalid message type: {msg_type}")
        return False

    if msg_type == "cancel_request":
        stream_id = message.get("stream_id")
        if not stream_id or not isinstance(stream_id, str):
            return False

        # Must be valid UUID
        try:
            uuid.UUID(stream_id)
        except ValueError:
            return False

    return True
```

### 2. HTML Sanitization

**Risk**: Markdown rendering could inject malicious scripts.

**Mitigation**:
- Use DOMPurify to sanitize all HTML before rendering
- Configure allowed tags/attributes for markdown
- CSP headers to prevent inline scripts

```javascript
// Configure DOMPurify
const PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    'p', 'br', 'strong', 'em', 'code', 'pre',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li', 'blockquote', 'a'
  ],
  ALLOWED_ATTR: ['href', 'class'],
  ALLOW_DATA_ATTR: false
};

function renderMarkdown(text) {
  const parsed = marked.parse(text);
  return DOMPurify.sanitize(parsed, PURIFY_CONFIG);
}
```

### 3. Rate Limiting

**Risk**: Spamming cancellation requests could DoS backend.

**Mitigation**:
- Client-side: Debounce cancel button (500ms)
- Server-side: Track cancel requests per session
- Limit to 5 cancellations per minute per session

### 4. Sensitive Data in Tool Summaries

**Risk**: Tool input/output summaries could leak sensitive data.

**Mitigation**:
- Truncate long inputs/outputs
- Filter out patterns resembling secrets (API keys, passwords)
- Redact file paths outside project directory

```python
import re

SENSITIVE_PATTERNS = [
    r'sk-[a-zA-Z0-9]{40,}',  # API keys
    r'password\s*=\s*["\'][^"\']+["\']',  # Passwords
    r'/home/[^/]+/\.ssh/',  # SSH keys
]

def sanitize_summary(text: str) -> str:
    """Remove sensitive patterns from tool summaries."""
    for pattern in SENSITIVE_PATTERNS:
        text = re.sub(pattern, '[REDACTED]', text)

    return text[:200]  # Max 200 chars
```

---

## Performance Considerations

### 1. WebSocket Backpressure

**Issue**: Fast SDK responses could overwhelm WebSocket buffer.

**Solution**: Implement buffering with max queue size.

```python
class BufferedWebSocketWriter:
    """Buffer messages to prevent WebSocket backpressure."""

    def __init__(self, websocket: WebSocket, max_buffer: int = 100):
        self.ws = websocket
        self.buffer = asyncio.Queue(maxsize=max_buffer)
        self._sender_task = asyncio.create_task(self._send_loop())

    async def send(self, message: dict):
        """Queue message for sending."""
        try:
            self.buffer.put_nowait(message)
        except asyncio.QueueFull:
            # Buffer full - wait
            await self.buffer.put(message)

    async def _send_loop(self):
        """Continuously flush buffer to WebSocket."""
        while True:
            msg = await self.buffer.get()
            if msg is None:  # Shutdown signal
                break
            await self.ws.send_json(msg)

    async def close(self):
        """Signal shutdown."""
        await self.buffer.put(None)
        await self._sender_task
```

### 2. Tool Activity Batching

**Issue**: Many rapid tool executions create excessive WebSocket traffic.

**Solution**: Batch tool updates every 50ms.

```python
class ToolActivityBatcher:
    """Batch rapid tool activity updates."""

    def __init__(self, flush_interval_ms: int = 50):
        self.interval = flush_interval_ms / 1000
        self.pending: List[ToolActivity] = []
        self.last_flush = time.time()

    def add(self, activity: ToolActivity) -> Optional[List[dict]]:
        """Add activity, return batch if ready to flush."""
        self.pending.append(activity)

        if (time.time() - self.last_flush) >= self.interval:
            batch = [a.model_dump() for a in self.pending]
            self.pending = []
            self.last_flush = time.time()
            return batch

        return None
```

### 3. Markdown Rendering Optimization

**Issue**: Re-parsing entire markdown on each chunk is expensive.

**Solution**: Incremental rendering for text chunks.

```javascript
// Optimize: only parse new content
function appendMarkdownChunk(newContent) {
  const container = lastAssistantMessage;
  const existingLength = parseInt(container.dataset.contentLength || '0');

  // Append raw content
  container.dataset.rawContent += newContent;
  container.dataset.contentLength = container.dataset.rawContent.length;

  // Only re-parse if we have a complete block
  if (newContent.includes('\n\n') || newContent.includes('```')) {
    // Full re-parse (structural change)
    const parsed = marked.parse(container.dataset.rawContent);
    container.innerHTML = DOMPurify.sanitize(parsed);
    highlightCodeBlocks(container);
  } else {
    // Incremental append (optimization for streaming text)
    const lastParagraph = container.querySelector('p:last-child');
    if (lastParagraph) {
      lastParagraph.textContent += newContent;
    } else {
      container.textContent += newContent;
    }
  }
}
```

---

## Testing Strategy

### 1. Unit Tests

**Backend Message Models** (`tests/unit/test_messages.py`):
```python
def test_tool_activity_model():
    """Test ToolActivity message validation."""
    activity = ToolActivity(
        tool_id="tool-123",
        tool_name="Read",
        status=ToolActivityStatus.EXECUTING,
        input_summary="Reading file.txt"
    )

    assert activity.type == "tool_activity"
    assert activity.tool_name == "Read"
    assert activity.status == ToolActivityStatus.EXECUTING

def test_stream_control_model():
    """Test StreamControl message validation."""
    control = StreamControl(
        action=StreamControlAction.STARTED,
        stream_id="stream-456"
    )

    assert control.type == "stream_control"
    assert control.action == StreamControlAction.STARTED
```

**Stream Controller** (`tests/unit/test_stream_controller.py`):
```python
def test_create_stream():
    """Test stream creation."""
    controller = StreamController()
    cancel_event = controller.create_stream("test-stream")

    assert not cancel_event.is_set()
    assert controller.get_state("test-stream") == "streaming"

def test_cancel_stream():
    """Test stream cancellation."""
    controller = StreamController()
    cancel_event = controller.create_stream("test-stream")

    assert controller.cancel_stream("test-stream") is True
    assert cancel_event.is_set()
    assert controller.get_state("test-stream") == "cancelling"

def test_cancel_nonexistent_stream():
    """Test cancelling non-existent stream."""
    controller = StreamController()
    assert controller.cancel_stream("fake-stream") is False
```

### 2. Integration Tests

**WebSocket Message Flow** (`tests/integration/test_websocket_flow.py`):
```python
async def test_full_message_flow():
    """Test complete message flow from request to completion."""
    async with TestWebSocketClient() as client:
        # Send chat message
        await client.send({
            "type": "send_chat",
            "session_id": "test-session",
            "message": "test message",
            "context": {}
        })

        messages = []
        async for msg in client.receive_stream():
            messages.append(msg)
            if msg.get("type") == "stream_control" and msg.get("action") == "completed":
                break

        # Verify message sequence
        assert messages[0]["type"] == "stream_control"
        assert messages[0]["action"] == "started"

        assert messages[-1]["type"] == "stream_control"
        assert messages[-1]["action"] == "completed"

        # Should have at least one response chunk
        response_chunks = [m for m in messages if m["type"] == "response_chunk"]
        assert len(response_chunks) > 0

async def test_cancellation_flow():
    """Test cancellation interrupts stream."""
    async with TestWebSocketClient() as client:
        # Start stream
        await client.send({
            "type": "send_chat",
            "session_id": "test-session",
            "message": "long task",
            "context": {}
        })

        # Wait for stream to start
        await client.wait_for_message(type="stream_control", action="started")

        # Cancel immediately
        stream_id = client.get_current_stream_id()
        await client.send({
            "type": "cancel_request",
            "session_id": "test-session",
            "stream_id": stream_id
        })

        # Should receive cancellation confirmation
        cancel_msg = await client.wait_for_message(
            type="stream_control",
            action="cancelled"
        )
        assert cancel_msg is not None
```

### 3. E2E Tests

**Frontend Tool Visibility** (`tests/e2e/test_tool_panel.spec.js`):
```javascript
test('tool activity panel shows during execution', async ({ page }) => {
  // Navigate to sidepanel
  await page.goto('chrome-extension://[id]/sidepanel.html');

  // Send message that triggers tool use
  await page.fill('#messageInput', 'Read package.json');
  await page.click('#sendBtn');

  // Tool panel should appear
  const toolPanel = page.locator('.tool-activity-panel');
  await expect(toolPanel).toBeVisible();

  // Should show at least one tool
  const toolItems = page.locator('.tool-item');
  await expect(toolItems).toHaveCountGreaterThan(0);

  // Tool should show "Read" operation
  const readTool = page.locator('.tool-item:has-text("Read")');
  await expect(readTool).toBeVisible();
});

test('stop button cancels streaming', async ({ page }) => {
  await page.goto('chrome-extension://[id]/sidepanel.html');

  // Start long-running operation
  await page.fill('#messageInput', 'Complex task');
  await page.click('#sendBtn');

  // Stop button should appear
  await expect(page.locator('#stopBtn')).toBeVisible();

  // Click stop
  await page.click('#stopBtn');

  // Should show cancellation message
  await expect(page.locator('text=Request cancelled')).toBeVisible();

  // Stop button should disappear
  await expect(page.locator('#stopBtn')).not.toBeVisible();
});
```

**Markdown Rendering** (`tests/e2e/test_markdown.spec.js`):
```javascript
test('markdown renders correctly', async ({ page }) => {
  await page.goto('chrome-extension://[id]/sidepanel.html');

  // Send message that returns markdown
  await page.fill('#messageInput', 'Show code example');
  await page.click('#sendBtn');

  // Wait for response
  await page.waitForSelector('.message.assistant');

  // Code block should be highlighted
  const codeBlock = page.locator('pre code');
  await expect(codeBlock).toBeVisible();

  // Should have syntax highlighting classes
  const hasHighlighting = await codeBlock.evaluate(
    el => el.classList.length > 1
  );
  expect(hasHighlighting).toBe(true);
});
```

### 4. Performance Tests

**Message Throughput** (`tests/performance/test_throughput.py`):
```python
async def test_high_frequency_messages():
    """Test system handles rapid message bursts."""
    async with TestWebSocketClient() as client:
        # Simulate SDK sending 100 messages/sec
        start = time.time()

        for i in range(100):
            await client.backend.send_message({
                "type": "response_chunk",
                "content": f"chunk {i}",
                "done": False
            })

        elapsed = time.time() - start

        # Should complete in < 2 seconds
        assert elapsed < 2.0

        # Client should receive all messages
        received = await client.get_received_count()
        assert received == 100
```

---

## Deployment Plan

### Phase 1: Backend Foundation (Week 1)

**Day 1-2**: Message Models
- [ ] Create `MessageType`, `ToolActivity`, `StreamControl` models
- [ ] Add unit tests for message validation
- [ ] Update `models/__init__.py` exports

**Day 3-4**: Stream Controller
- [ ] Implement `StreamController` class
- [ ] Add cancellation event handling
- [ ] Unit tests for stream lifecycle
- [ ] Integration with WebSocket handler

**Day 5**: Backend Integration
- [ ] Modify `ClaudeAgentSDKBackend.handle_chat()`
- [ ] Emit tool activity for `ToolUseBlock`
- [ ] Emit stream control messages
- [ ] Add cancellation checks

### Phase 2: Frontend Core (Week 2)

**Day 1-2**: Message Handler
- [ ] Implement multi-channel message routing
- [ ] Add `handleToolActivity()`, `handleStreamControl()`
- [ ] Update existing `handleResponseChunk()`

**Day 3-4**: Tool Activity Panel
- [ ] Create tool panel HTML/CSS
- [ ] Implement `renderToolActivityPanel()`
- [ ] Add status icons and formatting
- [ ] Auto-scroll functionality

**Day 5**: Stop Button
- [ ] Add stop button to HTML
- [ ] Implement `cancelStream()` function
- [ ] WebSocket cancel message sending
- [ ] UI state management (show/hide)

### Phase 3: UX Enhancements (Week 3)

**Day 1-2**: Markdown Rendering
- [ ] Add marked.js and DOMPurify libraries
- [ ] Update `appendToLastMessage()` for markdown
- [ ] Add code syntax highlighting
- [ ] Test with various markdown formats

**Day 3-4**: Visual Hierarchy
- [ ] Add message type CSS classes
- [ ] Implement collapsible sections
- [ ] Add timestamps to messages
- [ ] Enhance status indicators

**Day 5**: Accessibility
- [ ] Add ARIA attributes
- [ ] Keyboard navigation support
- [ ] Focus management
- [ ] Screen reader testing

### Phase 4: Testing & Polish (Week 4)

**Day 1-2**: Integration Testing
- [ ] WebSocket message flow tests
- [ ] Cancellation flow tests
- [ ] Error handling tests

**Day 3**: E2E Testing
- [ ] Tool panel visibility tests
- [ ] Stop button functionality tests
- [ ] Markdown rendering tests

**Day 4**: Performance Testing
- [ ] Message throughput benchmarks
- [ ] Memory usage profiling
- [ ] WebSocket latency measurements

**Day 5**: Documentation & Launch
- [ ] Update README with new features
- [ ] Record demo video
- [ ] User guide for new UI
- [ ] Deploy to production

---

## Migration Strategy

### Backward Compatibility

**Concern**: Existing sessions may not support new message types.

**Solution**: Graceful degradation
```python
# Backend sends both old and new formats initially
async def handle_chat_compatible(self, ...):
    async for msg in self._handle_chat_internal(...):
        # New format
        yield msg

        # Legacy format for old clients
        if msg["type"] == "tool_activity":
            # Convert to old status message
            yield {
                "type": "status",
                "status": "executing",
                "detail": f"Using {msg['tool_name']}"
            }
```

### Feature Flags

Control rollout with environment variables:
```python
# service/src/ui_chatter/config.py

ENABLE_MULTI_CHANNEL_STREAMING = os.getenv("MULTI_CHANNEL_STREAMING", "true").lower() == "true"
ENABLE_TOOL_VISIBILITY = os.getenv("TOOL_VISIBILITY", "true").lower() == "true"
ENABLE_MARKDOWN_RENDERING = os.getenv("MARKDOWN_RENDERING", "true").lower() == "true"
```

### Rollout Plan

1. **Week 1**: Deploy backend to dev environment
2. **Week 2**: Deploy frontend to dev, internal testing
3. **Week 3**: Beta release to 10% of users
4. **Week 4**: Full rollout to 100% if no issues

### Rollback Plan

If critical issues found:
1. Set `MULTI_CHANNEL_STREAMING=false` in environment
2. Backend reverts to old message format
3. Frontend detects old format, shows legacy UI
4. No data loss or corruption

---

## Monitoring & Metrics

### Key Metrics to Track

| Metric | Target | Alert Threshold |
|--------|--------|-----------------|
| Stream cancellation success rate | 95% | < 90% |
| Tool activity visibility rate | 100% | < 95% |
| WebSocket message latency (p95) | < 100ms | > 500ms |
| Frontend crash rate | < 0.1% | > 1% |
| Markdown rendering errors | < 0.5% | > 5% |

### Logging

**Backend**:
```python
# Log every stream lifecycle event
logger.info(f"Stream {stream_id} started", extra={
    "stream_id": stream_id,
    "session_id": session_id,
    "event": "stream_started"
})

logger.info(f"Tool {tool_name} executing", extra={
    "stream_id": stream_id,
    "tool_name": tool_name,
    "tool_id": tool_id,
    "event": "tool_executing"
})

logger.info(f"Stream {stream_id} completed", extra={
    "stream_id": stream_id,
    "duration_ms": duration,
    "tools_used": tool_count,
    "event": "stream_completed"
})
```

**Frontend**:
```javascript
// Track user interactions
analytics.track('stream_cancelled', {
  stream_id: currentStreamId,
  tools_running: activeTools.size,
  user_initiated: true
});

analytics.track('markdown_rendered', {
  content_length: content.length,
  has_code_blocks: content.includes('```'),
  render_time_ms: renderTime
});
```

---

## Open Questions

1. **Tool Result Size Limits**: What's the max size for `output_summary`? Should we truncate large outputs?
   - **Proposed**: Limit to 200 chars, provide "View full output" link

2. **Multiple Concurrent Streams**: Should we allow multiple streams per session?
   - **Proposed**: No, cancel previous stream when new one starts

3. **Tool Activity Persistence**: Should tool history persist across page reloads?
   - **Proposed**: No for MVP, consider in future iteration

4. **Progress Estimation**: Can we estimate completion % for long operations?
   - **Proposed**: Not in MVP, too complex without SDK support

5. **Offline Handling**: What happens if WebSocket disconnects mid-stream?
   - **Proposed**: Show "Connection lost" error, allow retry

---

## Success Criteria

### Must Have (P0)
- [x] Tool execution visibility (100% of tool calls shown)
- [x] Stop button cancels active stream
- [x] Markdown rendering with code highlighting
- [x] No "wall of text" - visual hierarchy and collapsing

### Should Have (P1)
- [x] Real-time streaming indicators
- [x] Tool execution timing (ms)
- [x] Error recovery with retry
- [x] Keyboard shortcuts (Escape to cancel)

### Nice to Have (P2)
- [ ] Progress estimation for multi-step operations
- [ ] Tool output preview on hover
- [ ] Session replay (view past tool executions)
- [ ] Export conversation with tool history

### User Acceptance
- Users can see what Claude is doing in real-time (100% visibility)
- Users can stop unwanted operations (95% success rate)
- Responses are readable and well-formatted (8/10 satisfaction)
- System feels responsive and transparent (< 3s to understand state)

---

## References

- **TS-0003**: Structured LLM Response Protocol (permission warnings)
- **TS-0005**: Claude Agent SDK Integration (SDK message types)
- **Claude Agent SDK Docs**: https://github.com/anthropics/claude-agent-sdk-python
- **WCAG 2.1 Guidelines**: https://www.w3.org/WAI/WCAG21/quickref/
- **WebSocket RFC 6455**: https://datatracker.ietf.org/doc/html/rfc6455

---

## Appendix A: Message Flow Examples

### Example 1: Simple Read Operation

```
Client → Server:
{
  "type": "send_chat",
  "message": "Read package.json",
  "context": {...}
}

Server → Client:
{
  "type": "stream_control",
  "action": "started",
  "stream_id": "stream-abc123"
}

{
  "type": "response_chunk",
  "content": "I'll read the package.json file for you.\n\n",
  "done": false
}

{
  "type": "tool_activity",
  "tool_id": "tool-1",
  "tool_name": "Read",
  "status": "executing",
  "input_summary": "Reading package.json"
}

{
  "type": "tool_activity",
  "tool_id": "tool-1",
  "tool_name": "Read",
  "status": "completed",
  "output_summary": "{\"name\": \"ui-chatter\", ...}",
  "duration_ms": 234
}

{
  "type": "response_chunk",
  "content": "The package.json file contains:\n```json\n{...}\n```",
  "done": false
}

{
  "type": "response_chunk",
  "content": "",
  "done": true
}

{
  "type": "stream_control",
  "action": "completed",
  "stream_id": "stream-abc123",
  "metadata": {
    "duration_ms": 1456,
    "tools_used": 1
  }
}
```

### Example 2: Cancellation Mid-Stream

```
Client → Server:
{
  "type": "send_chat",
  "message": "Refactor entire codebase",
  "context": {...}
}

Server → Client:
{
  "type": "stream_control",
  "action": "started",
  "stream_id": "stream-xyz789"
}

{
  "type": "tool_activity",
  "tool_id": "tool-1",
  "tool_name": "Glob",
  "status": "executing",
  "input_summary": "Finding *.ts files"
}

Client → Server (user clicks stop):
{
  "type": "cancel_request",
  "stream_id": "stream-xyz789"
}

Server → Client:
{
  "type": "stream_control",
  "action": "cancelled",
  "stream_id": "stream-xyz789",
  "reason": "user_request"
}
```

---

## Appendix B: CSS Class Reference

```css
/* Message Types */
.message              /* Base message style */
.message.user         /* User messages (right-aligned, blue) */
.message.assistant    /* Claude responses (left-aligned, green border) */
.message.system       /* System notifications (gray) */
.message.error        /* Error messages (red) */

/* Tool Panel */
.tool-activity-panel  /* Container for tool execution list */
.tool-panel-header    /* Header with icon and cancel button */
.tool-list            /* List of tool items */
.tool-item            /* Individual tool row */
.tool-status          /* Status icon (✓, ◐, ○, ✗) */
.tool-name            /* Tool name (Read, Write, etc.) */
.tool-input           /* Abbreviated input description */
.tool-duration        /* Execution time in ms */
.tool-summary         /* Summary footer with counts */

/* Tool States */
.tool-pending         /* Gray, not started */
.tool-executing       /* Blue border, animated */
.tool-completed       /* Green border */
.tool-failed          /* Red border */

/* UI Controls */
.btn-danger           /* Red stop button */
.cancel-btn           /* Cancel button in tool panel */
.expand-toggle        /* Show more/less button */

/* Indicators */
.thinking-indicator   /* Animated thinking dots */
.thinking-dots        /* Container for dot animation */
.thinking-text        /* "Claude is thinking..." text */

/* Responsive */
@media (max-width: 400px)  /* Mobile adjustments */
```

---

## Appendix C: Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Escape` | Cancel current stream |
| `Ctrl/Cmd + K` | Focus message input |
| `Ctrl/Cmd + Enter` | Send message |
| `Tab` | Navigate between inputs |
| `Shift + Tab` | Navigate backwards |

---

**Document Status**: DRAFT
**Last Updated**: 2026-01-30
**Next Review**: After Phase 1 completion
