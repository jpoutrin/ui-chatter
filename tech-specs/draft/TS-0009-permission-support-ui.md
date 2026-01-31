---
tech_spec_id: TS-0009
title: Interactive Permission Support for Claude Agent SDK
status: DRAFT
decision_ref:
author:
created: 2026-01-30
last_updated: 2026-01-31
related_docs: TS-0005, TS-0008
---

# TS-0009: Interactive Permission Support for Claude Agent SDK

## Executive Summary

Implement Claude Agent SDK's `canUseTool` callback to enable interactive permission approval in the UI Chatter extension. This adds a permission modal to the sidepanel that allows users to approve/deny tool executions and respond to Claude's clarifying questions (`AskUserQuestion`).

**Current State:**
- Permission modes (`bypassPermissions`, `plan`, `acceptEdits`) are configured at session level
- When using restrictive modes, SDK waits for approval but there's no UI to handle requests
- Users cannot see or respond to permission prompts or clarifying questions

**Target State:**
- Backend implements `canUseTool` callback with 60-second timeout
- WebSocket protocol extended with `permission_request` and `permission_response` messages
- Sidepanel displays permission modal with tool details, countdown timer, and approval controls
- Support for both tool approval flows and `AskUserQuestion` multi-choice prompts

**Key Benefits:**
- Users can review and approve dangerous operations (file deletion, command execution)
- Claude can ask clarifying questions interactively (library choices, implementation approaches)
- Better security through explicit approval for sensitive operations
- Enhanced UX with visual feedback and timeout handling

**References:**
- [SDK Permissions Documentation](https://platform.claude.com/docs/en/agent-sdk/permissions)
- [SDK User Input Documentation](https://platform.claude.com/docs/en/agent-sdk/user-input)

---

## Table of Contents

- [Design Overview](#design-overview)
- [Detailed Specifications](#detailed-specifications)
- [Data Model](#data-model)
- [API Specification](#api-specification)
- [Testing Strategy](#testing-strategy)
- [Implementation Checklist](#implementation-checklist)
- [References](#references)

---

## Design Overview

### Current Architecture

```
Extension → WebSocket → SessionManager → ClaudeAgentSDKBackend
                                              │
                                              └─> SDK query() WITH permission_mode
                                                  └─> SDK requests permission
                                                      └─> ⚠️ No callback → hangs/times out
```

**Problems:**
1. **No permission callback** - SDK waits for approval but receives no response
2. **No UI for approval** - Users cannot see or respond to permission requests
3. **No AskUserQuestion support** - Claude cannot ask clarifying questions interactively
4. **Poor UX for restrictive modes** - `plan` mode unusable without approval mechanism

### Target Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Chrome Extension (sidepanel.js)                            │
│                                                              │
│  ┌────────────────────────────────────────────────────┐    │
│  │  Permission Modal (NEW)                            │    │
│  │  - Shows tool name, command, file path             │    │
│  │  - 60s countdown timer                             │    │
│  │  - Allow/Deny buttons                              │    │
│  │  - AskUserQuestion multi-choice support            │    │
│  └────────────────────────────────────────────────────┘    │
│         │                                    ▲                │
│         │ permission_response                │                │
│         │                                    │ permission_request
└─────────┼────────────────────────────────────┼────────────────┘
          │                                    │
          │         WebSocket                  │
          │                                    │
┌─────────▼────────────────────────────────────┼────────────────┐
│  FastAPI Backend (main.py)                   │                │
│                                              │                │
│  WebSocket Handler                           │                │
│  - Routes permission_response to backend     │                │
│                                              │                │
│  ┌───────────────────────────────────────────┼─────────────┐ │
│  │  ClaudeAgentSDKBackend                    │             │ │
│  │                                           │             │ │
│  │  PermissionRequestManager (NEW)           │             │ │
│  │  - Stores pending requests                │             │ │
│  │  - Manages asyncio events for waiting     │             │ │
│  │  - Handles 60s timeout                    │             │ │
│  │                                           │             │ │
│  │  canUseTool callback (NEW)                │             │ │
│  │  ├─> Send permission_request via WS ──────┘             │ │
│  │  ├─> Wait for user response (asyncio.Event)            │ │
│  │  └─> Return PermissionResultAllow/Deny                 │ │
│  └─────────────────────────────────────────────────────────┘ │
│             │                                                 │
│             │ query(options=ClaudeAgentOptions(               │
│             │   can_use_tool=self._can_use_tool_callback))   │
│             ▼                                                 │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Claude Agent SDK                                    │   │
│  │  - Triggers canUseTool when permission needed        │   │
│  │  - Passes tool_name, input_data, context            │   │
│  │  - Waits for callback to return Allow/Deny          │   │
│  └──────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

**Solutions:**
1. **Backend callback** - Implement `canUseTool` with WebSocket communication
2. **Permission modal** - Visual UI for approval with tool details and timer
3. **Bidirectional protocol** - Request/response flow over WebSocket
4. **Timeout handling** - 60-second countdown with auto-deny fallback

---

## Detailed Specifications

### Phase 1: Backend Permission Callback

**Location**: `src/ui_chatter/backends/claude_agent_sdk.py`

#### 1.1 PermissionRequestManager Class

**Purpose:** Manage pending permission requests with asyncio events and timeout handling.

```python
import uuid

class PermissionRequestManager:
    """Manages pending permission requests from the SDK."""

    def __init__(self):
        self._pending_requests: Dict[str, dict] = {}

    def create_request(self) -> Tuple[str, asyncio.Event]:
        """Create a new permission request and return (request_id, event)."""
        request_id = str(uuid.uuid4())  # Use UUID to prevent collisions on service restart

        event = asyncio.Event()
        self._pending_requests[request_id] = {"event": event, "result": None}

        return request_id, event

    def resolve_request(self, request_id: str, result: dict) -> None:
        """Resolve a pending permission request with user's response."""
        if request_id in self._pending_requests:
            self._pending_requests[request_id]["result"] = result
            self._pending_requests[request_id]["event"].set()

    def cleanup_request(self, request_id: str) -> None:
        """Clean up a permission request after completion."""
        self._pending_requests.pop(request_id, None)
```

**Design Rationale:**
- **Request ID**: UUID-based unique identifier prevents collisions on service restart
- **Asyncio Event**: Allows callback to wait asynchronously without blocking
- **Result Storage**: Stores user response for callback to retrieve
- **Cleanup**: Prevents memory leaks from completed requests

#### 1.2 ClaudeAgentSDKBackend Updates

**Constructor Changes:**

```python
class ClaudeAgentSDKBackend(AgentBackend):
    def __init__(
        self,
        project_path: str,
        permission_mode: str = "bypassPermissions",
        ws_send_callback: Optional[Callable] = None,  # NEW
        **kwargs
    ):
        super().__init__(project_path)
        self.permission_mode = permission_mode
        self.allowed_tools = ["Read", "Write", "Edit", "Bash", "Glob", "Grep"]
        self.ws_send_callback = ws_send_callback  # NEW
        self.permission_manager = PermissionRequestManager()  # NEW
```

**Parameters:**
- `ws_send_callback`: Async callable to send messages to UI via WebSocket
- `permission_manager`: Instance of PermissionRequestManager for request tracking

#### 1.3 Backend Shutdown and Cleanup

```python
async def shutdown(self) -> None:
    """
    Cleanup resources and resolve pending permission requests.

    Called when:
    - Backend is being recreated (e.g., permission mode change)
    - Session is being destroyed
    - Service is shutting down

    This ensures SDK queries don't hang when backend is replaced.
    """
    # Deny all pending permissions
    for request_id in list(self.permission_manager._pending_requests.keys()):
        self.permission_manager.resolve_request(request_id, {
            "approved": False,
            "reason": "Backend shutdown during pending request"
        })

    logger.info("Claude Agent SDK backend shutdown complete")
```

**Integration**: Update `session_manager.py` to call shutdown:

```python
async def update_permission_mode(self, session_id: str, new_mode: str) -> None:
    session = self.sessions.get(session_id)

    # Cleanup old backend before recreating
    if hasattr(session.backend, 'shutdown'):
        await session.backend.shutdown()

    # Recreate with new mode
    session.backend = self._create_backend(...)
```

#### 1.4 canUseTool Callback Implementation

```python
async def _can_use_tool_callback(
    self,
    tool_name: str,
    input_data: dict,
    context: ToolPermissionContext
) -> PermissionResultAllow | PermissionResultDeny:
    """
    Permission callback for Claude Agent SDK.

    Handles two flows:
    1. Tool permission requests (Bash, Write, Edit, etc.)
    2. AskUserQuestion prompts (multi-choice questions from Claude)

    Returns:
        PermissionResultAllow: If approved (with optional modified input)
        PermissionResultDeny: If denied or timeout (with reason message)
    """
    from claude_agent_sdk.types import PermissionResultAllow, PermissionResultDeny

    # Special handling for AskUserQuestion
    if tool_name == "AskUserQuestion":
        return await self._handle_ask_user_question(input_data)

    # Bypass mode: auto-approve everything
    if self.permission_mode == "bypassPermissions":
        return PermissionResultAllow(updated_input=input_data)

    # For other modes, request user approval
    return await self._request_permission_from_ui(tool_name, input_data, context)
```

**Flow Diagram:**

```
SDK calls canUseTool
    │
    ├─> tool_name == "AskUserQuestion"?
    │   └─> Yes → _handle_ask_user_question()
    │
    ├─> permission_mode == "bypassPermissions"?
    │   └─> Yes → Return Allow (auto-approve)
    │
    └─> No → _request_permission_from_ui()
        ├─> Generate request_id
        ├─> Send permission_request via WebSocket
        ├─> Wait for response (60s timeout)
        ├─> Return Allow or Deny based on response
        └─> Cleanup request
```

#### 1.5 Request Permission from UI

```python
async def _request_permission_from_ui(
    self,
    tool_name: str,
    input_data: dict,
    context: ToolPermissionContext
) -> PermissionResultAllow | PermissionResultDeny:
    """Send permission request to UI and wait for user response."""
    if not self.ws_send_callback:
        logger.warning("No WebSocket callback, denying permission")
        return PermissionResultDeny(message="No UI connection available")

    # Create permission request
    request_id, event = self.permission_manager.create_request()

    # Send request to UI via WebSocket with error handling
    try:
        await self.ws_send_callback({
            "type": "permission_request",
            "request_id": request_id,
            "request_type": "tool_approval",
            "tool_name": tool_name,
            "input_data": input_data,
            "timeout_seconds": 60,
            "timestamp": datetime.utcnow().isoformat()
        })
    except Exception as e:
        # WebSocket send failed (disconnection, etc.)
        self.permission_manager.cleanup_request(request_id)
        logger.warning(f"Failed to send permission request: {e}")
        return PermissionResultDeny(message=f"Connection lost: {e}")

    # Wait for user response with 60s timeout
    try:
        await asyncio.wait_for(event.wait(), timeout=60.0)

        # Get result
        result = self.permission_manager._pending_requests[request_id]["result"]
        self.permission_manager.cleanup_request(request_id)

        if result["approved"]:
            return PermissionResultAllow(
                updated_input=result.get("modified_input") or input_data
            )
        else:
            return PermissionResultDeny(
                message=result.get("reason") or "User denied permission"
            )

    except asyncio.TimeoutError:
        self.permission_manager.cleanup_request(request_id)
        logger.warning(f"Permission request {request_id} timed out")
        return PermissionResultDeny(
            message="Permission request timed out (60 seconds)"
        )
```

**Key Features:**
- **60-second timeout**: SDK requirement, auto-denies on timeout
- **Async waiting**: Non-blocking wait for user response
- **Error handling**: Graceful fallback if WebSocket unavailable or connection lost
- **Result retrieval**: Fetches user decision from manager after event is set
- **WebSocket error handling**: Try/except wrapper prevents hung requests on disconnection

#### 1.6 AskUserQuestion Handler

```python
async def _handle_ask_user_question(
    self,
    input_data: dict
) -> PermissionResultAllow | PermissionResultDeny:
    """Handle AskUserQuestion tool - display multi-choice questions to user."""
    if not self.ws_send_callback:
        return PermissionResultDeny(message="No UI connection available")

    request_id, event = self.permission_manager.create_request()

    # Send AskUserQuestion request to UI
    await self.ws_send_callback({
        "type": "permission_request",
        "request_id": request_id,
        "request_type": "ask_user_question",
        "questions": input_data.get("questions", []),
        "timeout_seconds": 60
    })

    # Wait for answers with timeout
    try:
        await asyncio.wait_for(event.wait(), timeout=60.0)

        result = self.permission_manager._pending_requests[request_id]["result"]
        self.permission_manager.cleanup_request(request_id)

        if result["approved"]:
            # Return answers in SDK format
            return PermissionResultAllow(
                updated_input={
                    "questions": input_data.get("questions", []),
                    "answers": result.get("answers", {})
                }
            )
        else:
            return PermissionResultDeny(message="User did not answer")

    except asyncio.TimeoutError:
        self.permission_manager.cleanup_request(request_id)
        return PermissionResultDeny(message="Question timed out (60 seconds)")
```

**Question Format (Input):**
```json
{
  "questions": [
    {
      "question": "Which library should we use?",
      "header": "Library",
      "options": [
        {"label": "React", "description": "Modern UI library"},
        {"label": "Vue", "description": "Progressive framework"}
      ],
      "multiSelect": false
    }
  ]
}
```

**Answer Format (Output):**
```json
{
  "questions": [...],  // Pass through original questions
  "answers": {
    "Which library should we use?": "React"
  }
}
```

#### 1.7 Public Resolution Method

```python
def resolve_permission(self, request_id: str, response: dict) -> None:
    """
    Called by WebSocket handler to resolve a permission request.

    Args:
        request_id: Unique identifier from permission_request
        response: User's response containing approved, modified_input, answers, reason
    """
    self.permission_manager.resolve_request(request_id, response)
```

**Usage in WebSocket Handler:**
```python
# In main.py WebSocket loop
elif message_type == "permission_response":
    session.backend.resolve_permission(request_id, {
        "approved": data.get("approved"),
        "modified_input": data.get("modified_input"),
        "answers": data.get("answers"),
        "reason": data.get("reason")
    })
```

#### 1.8 Integration with SDK Query

```python
async def handle_chat(
    self,
    context: CapturedContext,
    message: str,
    is_first_message: bool = False,
    screenshot_path: Optional[str] = None,
    cancel_event: Optional[asyncio.Event] = None,
) -> AsyncGenerator[dict, None]:
    # ... existing code ...

    # Pass canUseTool callback to SDK
    async for msg in query(
        prompt=prompt,
        options=ClaudeAgentOptions(
            session_id=self.sdk_session_id,
            allowed_tools=self.allowed_tools,
            permission_mode=self.permission_mode,
            cwd=self.project_path,
            can_use_tool=self._can_use_tool_callback,  # NEW
        )
    ):
        # ... existing message processing ...
```

---

### Phase 2: WebSocket Protocol Extensions

**Location**: `src/ui_chatter/models/messages.py`

#### 2.1 Permission Message Models

```python
from pydantic import BaseModel, Field
from typing import Literal, Optional

class PermissionRequest(BaseModel):
    """Permission request sent to UI."""
    type: str = Field(default="permission_request")
    request_id: str = Field(..., description="Unique request identifier")
    request_type: Literal["tool_approval", "ask_user_question"]
    tool_name: Optional[str] = Field(None, description="Tool name (for tool_approval)")
    input_data: Optional[dict] = Field(None, description="Tool parameters (for tool_approval)")
    questions: Optional[list] = Field(None, description="Questions (for ask_user_question)")
    timeout_seconds: int = Field(default=60, description="Seconds until auto-deny")
    timestamp: str = Field(..., description="ISO 8601 timestamp")

class PermissionResponse(BaseModel):
    """Permission response from UI."""
    type: str = Field(default="permission_response")
    request_id: str = Field(..., description="Request ID from permission_request")
    approved: bool = Field(..., description="True if user approved")
    modified_input: Optional[dict] = Field(None, description="Modified tool parameters (optional)")
    answers: Optional[dict] = Field(None, description="Question answers (for ask_user_question)")
    reason: Optional[str] = Field(None, description="Denial reason (if approved=false)")
```

**Message Examples:**

**Tool Approval Request:**
```json
{
  "type": "permission_request",
  "request_id": "550e8400-e29b-41d4-a716-446655440000",
  "request_type": "tool_approval",
  "tool_name": "Bash",
  "input_data": {
    "command": "rm -rf /tmp/test.txt",
    "description": "Delete test file"
  },
  "timeout_seconds": 60,
  "timestamp": "2026-01-30T10:00:00Z"
}
```

**AskUserQuestion Request:**
```json
{
  "type": "permission_request",
  "request_id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "request_type": "ask_user_question",
  "questions": [
    {
      "question": "Which authentication method should we use?",
      "header": "Auth Method",
      "options": [
        {"label": "JWT", "description": "Stateless token-based auth"},
        {"label": "Sessions", "description": "Server-side session management"}
      ],
      "multiSelect": false
    }
  ],
  "timeout_seconds": 60
}
```

**Permission Response (Approved):**
```json
{
  "type": "permission_response",
  "request_id": "550e8400-e29b-41d4-a716-446655440000",
  "approved": true,
  "modified_input": null,
  "reason": null
}
```

**Permission Response (Denied):**
```json
{
  "type": "permission_response",
  "request_id": "550e8400-e29b-41d4-a716-446655440000",
  "approved": false,
  "modified_input": null,
  "reason": "User denied permission"
}
```

**AskUserQuestion Response:**
```json
{
  "type": "permission_response",
  "request_id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "approved": true,
  "answers": {
    "Which authentication method should we use?": "JWT"
  }
}
```

#### 2.2 WebSocket Handler Updates

**Location**: `src/ui_chatter/main.py`

**Add permission_response Handler:**

```python
# In WebSocket message loop (after line 300)
elif message_type == "permission_response":
    # Handle permission response from UI
    request_id = data.get("request_id")
    if not request_id:
        await connection_manager.send_message(
            session_id,
            {
                "type": "error",
                "code": "invalid_request",
                "message": "Missing request_id in permission_response"
            }
        )
        continue

    # Get session's backend instance and resolve permission
    session = session_manager.sessions.get(session_id)
    if session and hasattr(session, "backend"):
        session.backend.resolve_permission(request_id, {
            "approved": data.get("approved", False),
            "modified_input": data.get("modified_input"),
            "answers": data.get("answers"),
            "reason": data.get("reason")
        })
        logger.info(
            f"Resolved permission {request_id}: approved={data.get('approved')}"
        )
    else:
        logger.warning(f"No backend found for session {session_id}")
```

**Pass WebSocket Callback to Backend:**

```python
# In session creation (around line 200)
async def create_backend_with_ws_callback(session_id: str, backend_config: dict):
    """Create backend with WebSocket send callback."""

    async def ws_send(message: dict):
        """Callback for backend to send messages to UI."""
        await connection_manager.send_message(session_id, message)

    backend = create_backend(
        backend_type=backend_config.get("backend_type"),
        project_path=backend_config.get("project_path"),
        permission_mode=backend_config.get("permission_mode"),
        ws_send_callback=ws_send,  # NEW
        api_key=settings.ANTHROPIC_API_KEY,
    )

    return backend
```

---

### Phase 3: UI Permission Modal

**Location**: `poc/extension/sidepanel.html`

#### 3.1 Modal HTML Structure

```html
<!-- Add before closing </body> tag -->
<div id="permissionModal" class="permission-modal" style="display: none;">
  <div class="permission-overlay"></div>
  <div class="permission-dialog">
    <div class="permission-header">
      <span class="permission-icon">🔐</span>
      <h3 id="permissionTitle">Permission Required</h3>
      <span id="permissionTimer" class="permission-timer">60s</span>
    </div>

    <div class="permission-body">
      <!-- Tool approval UI -->
      <div id="toolApprovalContent" style="display: none;">
        <div class="tool-info">
          <div class="tool-label">Tool:</div>
          <div id="permissionToolName" class="tool-value"></div>
        </div>

        <div class="tool-input">
          <div class="tool-label">Details:</div>
          <pre id="permissionToolInput" class="tool-input-display"></pre>
        </div>
      </div>

      <!-- AskUserQuestion UI -->
      <div id="questionContainer" style="display: none;">
        <!-- Dynamically populated with radio/checkbox options -->
      </div>
    </div>

    <div class="permission-footer">
      <button id="denyBtn" class="btn btn-secondary">Deny (Esc)</button>
      <button id="allowBtn" class="btn btn-primary">Allow (Enter)</button>
    </div>
  </div>
</div>
```

**Visual Design:**

```
┌─────────────────────────────────────────────────────┐
│ 🔐 Permission Required                       60s    │
├─────────────────────────────────────────────────────┤
│                                                     │
│ Tool: Bash                                          │
│                                                     │
│ Details:                                            │
│ ┌─────────────────────────────────────────────────┐│
│ │ $ rm -rf /tmp/test.txt                          ││
│ │                                                 ││
│ │ Delete test file                                ││
│ └─────────────────────────────────────────────────┘│
│                                                     │
├─────────────────────────────────────────────────────┤
│                            [Deny (Esc)] [Allow (Enter)]│
└─────────────────────────────────────────────────────┘
```

#### 3.2 JavaScript Implementation

**Location**: `poc/extension/sidepanel.js`

**State Variables:**

```javascript
// Permission modal state
let currentPermissionRequest = null;
let permissionTimer = null;
```

**Main Handler:**

```javascript
function handlePermissionRequest(message) {
  const {
    request_id,
    request_type,
    tool_name,
    input_data,
    questions,
    timeout_seconds
  } = message;

  currentPermissionRequest = { request_id, request_type };

  if (request_type === 'ask_user_question') {
    showAskUserQuestion(questions, timeout_seconds);
  } else {
    showToolPermission(tool_name, input_data, timeout_seconds);
  }
}
```

**Tool Permission Display:**

```javascript
function showToolPermission(toolName, inputData, timeoutSeconds) {
  // Show tool approval UI, hide question UI
  document.getElementById('toolApprovalContent').style.display = 'block';
  document.getElementById('questionContainer').style.display = 'none';

  // Populate tool details
  document.getElementById('permissionToolName').textContent = toolName;
  document.getElementById('permissionToolInput').textContent =
    formatToolInput(toolName, inputData);

  // Show modal
  document.getElementById('permissionModal').style.display = 'block';

  // Start countdown timer (58s client-side, 60s server-side)
  // This ensures client response arrives before server timeout
  startPermissionTimer(Math.max(58, timeoutSeconds - 2));

  // Focus allow button for keyboard accessibility
  document.getElementById('allowBtn').focus();
}

function formatToolInput(toolName, input) {
  // Tool-specific formatting for better readability
  if (toolName === 'Bash') {
    const cmd = input.command || '';
    const desc = input.description || '';

    // Highlight dangerous patterns
    let formatted = `$ ${cmd}`;
    if (cmd.includes('rm ') || cmd.includes('sudo') || cmd.includes('--force')) {
      formatted = `⚠️ DANGER: ${formatted}`;
    }

    if (desc) {
      formatted += `\n\n${desc}`;
    }

    return formatted;
  } else if (toolName === 'Write') {
    const path = input.file_path || '';
    const content = input.content || '';
    const preview = content.substring(0, 200);
    return `File: ${path}\n\nContent preview:\n${preview}${
      content.length > 200 ? '...' : ''
    }`;
  } else if (toolName === 'Edit') {
    return `File: ${input.file_path}\n\nOld: ${input.old_string}\nNew: ${input.new_string}`;
  } else if (toolName === 'Read') {
    return `File: ${input.file_path}${
      input.offset ? `\nOffset: ${input.offset}` : ''
    }${input.limit ? `\nLimit: ${input.limit} lines` : ''}`;
  } else {
    return JSON.stringify(input, null, 2);
  }
}
```

**Timer Management:**

```javascript
/**
 * Timer Synchronization Strategy:
 *
 * Server: 60-second timeout in asyncio.wait_for()
 * Client: 58-second timer display
 *
 * The 2-second buffer ensures that user responses sent near
 * the timeout boundary arrive at the server before it times out,
 * accounting for network latency.
 */
function startPermissionTimer(seconds) {
  let remaining = seconds;  // Should be 58, not 60
  const timerEl = document.getElementById('permissionTimer');

  permissionTimer = setInterval(() => {
    remaining--;
    timerEl.textContent = `${remaining}s`;

    // Visual warning when time is running out
    if (remaining <= 10) {
      timerEl.classList.add('warning');
    }

    if (remaining === 0) {
      clearInterval(permissionTimer);
      // Auto-deny on timeout
      respondToPermission(false, null);
    }
  }, 1000);
}
```

**Response Handler:**

```javascript
function respondToPermission(approved, modifiedInput = null, answers = null) {
  clearInterval(permissionTimer);

  // Send response via background script
  chrome.runtime.sendMessage({
    type: 'sendToServer',
    data: {
      type: 'permission_response',
      request_id: currentPermissionRequest.request_id,
      approved,
      modified_input: modifiedInput,
      answers: answers,
      reason: approved ? null : 'User denied'
    }
  });

  // Hide modal
  document.getElementById('permissionModal').style.display = 'none';
  document.getElementById('permissionTimer').classList.remove('warning');
  currentPermissionRequest = null;
}
```

**AskUserQuestion Handler:**

```javascript
function showAskUserQuestion(questions, timeoutSeconds) {
  // Hide tool UI, show question UI
  document.getElementById('toolApprovalContent').style.display = 'none';
  document.getElementById('questionContainer').style.display = 'block';

  const container = document.getElementById('questionContainer');
  container.innerHTML = '';

  // Store questions for later retrieval
  currentPermissionRequest.questions = questions;

  questions.forEach((q, index) => {
    const questionDiv = document.createElement('div');
    questionDiv.className = 'question-block';

    const header = document.createElement('h4');
    header.textContent = q.header || q.question;
    questionDiv.appendChild(header);

    const paragraph = document.createElement('p');
    paragraph.textContent = q.question;
    paragraph.className = 'question-text';
    questionDiv.appendChild(paragraph);

    q.options.forEach(opt => {
      const label = document.createElement('label');
      label.className = 'option-label';

      const input = document.createElement('input');
      input.type = q.multiSelect ? 'checkbox' : 'radio';
      input.name = `question-${index}`;
      input.value = opt.label;
      input.className = 'option-input';

      label.appendChild(input);

      const optionText = document.createElement('div');
      optionText.className = 'option-text';

      const optionLabel = document.createElement('div');
      optionLabel.className = 'option-label-text';
      optionLabel.textContent = opt.label;
      optionText.appendChild(optionLabel);

      if (opt.description) {
        const desc = document.createElement('div');
        desc.className = 'option-description';
        desc.textContent = opt.description;
        optionText.appendChild(desc);
      }

      label.appendChild(optionText);
      questionDiv.appendChild(label);
    });

    container.appendChild(questionDiv);
  });

  document.getElementById('permissionModal').style.display = 'block';
  startPermissionTimer(timeoutSeconds);
}

function collectQuestionAnswers() {
  const questions = currentPermissionRequest.questions;
  const answers = {};

  questions.forEach((q, index) => {
    const inputs = document.querySelectorAll(
      `input[name="question-${index}"]:checked`
    );

    if (q.multiSelect) {
      // Multi-select: join labels with ", "
      answers[q.question] = Array.from(inputs)
        .map(i => i.value)
        .join(', ');
    } else {
      // Single select: just the label
      answers[q.question] = inputs[0]?.value || '';
    }
  });

  return answers;
}
```

**Event Listeners:**

```javascript
// Button click handlers
document.getElementById('allowBtn').addEventListener('click', () => {
  if (currentPermissionRequest.request_type === 'ask_user_question') {
    const answers = collectQuestionAnswers();
    respondToPermission(true, null, answers);
  } else {
    respondToPermission(true, null, null);
  }
});

document.getElementById('denyBtn').addEventListener('click', () => {
  respondToPermission(false, null, null);
});

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  if (!currentPermissionRequest) return;

  if (e.key === 'Enter') {
    e.preventDefault();
    if (currentPermissionRequest.request_type === 'ask_user_question') {
      const answers = collectQuestionAnswers();
      respondToPermission(true, null, answers);
    } else {
      respondToPermission(true, null, null);
    }
  } else if (e.key === 'Escape') {
    e.preventDefault();
    respondToPermission(false, null, null);
  }
});

// Add to existing message handler
chrome.runtime.onMessage.addListener(message => {
  if (message.type === 'permission_request') {
    handlePermissionRequest(message);
  }
  // ... existing handlers ...
});
```

#### 3.3 CSS Styling

```css
/* Permission Modal Styles */
.permission-modal {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 1000;
}

.permission-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(2px);
}

.permission-dialog {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  background: white;
  border-radius: 12px;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
  max-width: 500px;
  width: 90%;
  max-height: 80vh;
  overflow-y: auto;
}

.permission-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 20px;
  border-bottom: 1px solid #e5e7eb;
}

.permission-icon {
  font-size: 24px;
}

.permission-header h3 {
  flex: 1;
  margin: 0;
  font-size: 18px;
}

.permission-timer {
  font-weight: 600;
  padding: 4px 12px;
  background: #f3f4f6;
  border-radius: 12px;
  font-size: 14px;
}

.permission-timer.warning {
  background: #fee2e2;
  color: #ef4444;
  animation: pulse 1s infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}

.permission-body {
  padding: 20px;
}

.tool-info {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
}

.tool-label {
  font-weight: 600;
  color: #6b7280;
  min-width: 60px;
}

.tool-value {
  font-family: 'Courier New', monospace;
  font-weight: 600;
}

.tool-input {
  margin-top: 16px;
}

.tool-input-display {
  background: #1f2937;
  color: #e5e7eb;
  padding: 12px;
  border-radius: 6px;
  overflow-x: auto;
  font-family: 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
}

.question-block {
  margin-bottom: 24px;
}

.question-block h4 {
  margin: 0 0 8px 0;
  font-size: 16px;
}

.question-text {
  margin: 0 0 12px 0;
  color: #6b7280;
}

.option-label {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  margin-bottom: 8px;
  cursor: pointer;
  transition: background-color 0.2s;
}

.option-label:hover {
  background: #f9fafb;
}

.option-input {
  margin-top: 4px;
  cursor: pointer;
}

.option-text {
  flex: 1;
}

.option-label-text {
  font-weight: 500;
  margin-bottom: 4px;
}

.option-description {
  font-size: 13px;
  color: #6b7280;
}

.permission-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding: 16px 20px;
  border-top: 1px solid #e5e7eb;
}

.btn {
  padding: 10px 20px;
  border: none;
  border-radius: 6px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-primary {
  background: #2563eb;
  color: white;
}

.btn-primary:hover {
  background: #1d4ed8;
}

.btn-secondary {
  background: #f3f4f6;
  color: #374151;
}

.btn-secondary:hover {
  background: #e5e7eb;
}
```

---

## Data Model

### Permission Request Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| type | string | Yes | Always "permission_request" |
| request_id | string | Yes | UUID unique identifier (e.g., "550e8400-e29b-41d4-a716-446655440000") |
| request_type | enum | Yes | "tool_approval" or "ask_user_question" |
| tool_name | string | Conditional | Tool name (required for tool_approval) |
| input_data | object | Conditional | Tool parameters (required for tool_approval) |
| questions | array | Conditional | Question list (required for ask_user_question) |
| timeout_seconds | integer | Yes | Seconds until auto-deny (default: 60) |
| timestamp | string | Yes | ISO 8601 timestamp |

### Permission Response Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| type | string | Yes | Always "permission_response" |
| request_id | string | Yes | Matches request_id from permission_request |
| approved | boolean | Yes | True if user approved, false if denied |
| modified_input | object | No | Modified tool parameters (if user edited) |
| answers | object | No | Question answers (for ask_user_question) |
| reason | string | No | Denial reason (if approved=false) |

### Tool Input Formats

**Bash Tool:**
```json
{
  "command": "rm -rf /tmp/test.txt",
  "description": "Delete test file",
  "timeout": 120000
}
```

**Write Tool:**
```json
{
  "file_path": "/path/to/file.txt",
  "content": "File contents here..."
}
```

**Edit Tool:**
```json
{
  "file_path": "/path/to/file.txt",
  "old_string": "original text",
  "new_string": "replacement text",
  "replace_all": false
}
```

**Read Tool:**
```json
{
  "file_path": "/path/to/file.txt",
  "offset": 0,
  "limit": 100
}
```

### Question Format (AskUserQuestion)

```json
{
  "question": "Which authentication method should we use?",
  "header": "Auth",
  "options": [
    {"label": "JWT", "description": "Stateless token-based authentication"},
    {"label": "Sessions", "description": "Server-side session management"},
    {"label": "OAuth", "description": "Third-party authentication provider"}
  ],
  "multiSelect": false
}
```

**Answer Format:**
```json
{
  "Which authentication method should we use?": "JWT"
}
```

**Multi-Select Answer Format:**
```json
{
  "Which features do you want?": "Authentication, Database, API"
}
```

---

## API Specification

### Backend API

#### ClaudeAgentSDKBackend.__init__

```python
def __init__(
    project_path: str,
    permission_mode: str = "bypassPermissions",
    ws_send_callback: Optional[Callable] = None,
    **kwargs
)
```

**Parameters:**
- `project_path`: Working directory for agent operations
- `permission_mode`: Permission level (bypassPermissions, plan, acceptEdits, etc.)
- `ws_send_callback`: Async callable to send messages to UI via WebSocket
- `**kwargs`: Additional backend-specific parameters

#### ClaudeAgentSDKBackend.resolve_permission

```python
def resolve_permission(request_id: str, response: dict) -> None
```

**Parameters:**
- `request_id`: Unique identifier from permission_request
- `response`: User's response containing:
  - `approved` (bool): True if user approved
  - `modified_input` (dict, optional): Modified tool parameters
  - `answers` (dict, optional): Question answers
  - `reason` (str, optional): Denial reason

### WebSocket Messages

#### permission_request (Server → Client)

**For Tool Approval:**
```json
{
  "type": "permission_request",
  "request_id": "550e8400-e29b-41d4-a716-446655440000",
  "request_type": "tool_approval",
  "tool_name": "Bash",
  "input_data": {
    "command": "rm -rf /tmp/test.txt",
    "description": "Delete test file"
  },
  "timeout_seconds": 60,
  "timestamp": "2026-01-30T10:00:00Z"
}
```

**For AskUserQuestion:**
```json
{
  "type": "permission_request",
  "request_id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "request_type": "ask_user_question",
  "questions": [
    {
      "question": "Which library?",
      "header": "Library",
      "options": [
        {"label": "React", "description": "UI library"},
        {"label": "Vue", "description": "Framework"}
      ],
      "multiSelect": false
    }
  ],
  "timeout_seconds": 60
}
```

#### permission_response (Client → Server)

**Approved:**
```json
{
  "type": "permission_response",
  "request_id": "550e8400-e29b-41d4-a716-446655440000",
  "approved": true,
  "modified_input": null,
  "reason": null
}
```

**Denied:**
```json
{
  "type": "permission_response",
  "request_id": "550e8400-e29b-41d4-a716-446655440000",
  "approved": false,
  "modified_input": null,
  "reason": "User denied permission"
}
```

**With Answers:**
```json
{
  "type": "permission_response",
  "request_id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "approved": true,
  "answers": {
    "Which library?": "React"
  }
}
```

---

## Testing Strategy

### Unit Tests (Backend)

**File**: `tests/test_permission_callback.py`

**Note:** All backend tests should verify proper cleanup on shutdown and WebSocket disconnection scenarios.

```python
import asyncio
import pytest
from src.ui_chatter.backends.claude_agent_sdk import ClaudeAgentSDKBackend

@pytest.mark.asyncio
async def test_bypass_mode_auto_approves():
    """Bypass mode should auto-approve all tool requests."""
    backend = ClaudeAgentSDKBackend(
        project_path="/test",
        permission_mode="bypassPermissions"
    )

    result = await backend._can_use_tool_callback(
        "Bash", {"command": "ls"}, None
    )

    assert result.behavior == "allow"

@pytest.mark.asyncio
async def test_plan_mode_requires_approval():
    """Plan mode should request user approval via WebSocket."""
    mock_send = AsyncMock()
    backend = ClaudeAgentSDKBackend(
        project_path="/test",
        permission_mode="plan",
        ws_send_callback=mock_send
    )

    # Trigger callback
    task = asyncio.create_task(
        backend._can_use_tool_callback("Bash", {"command": "ls"}, None)
    )

    # Wait for request to be sent
    await asyncio.sleep(0.1)

    # Verify request sent
    assert mock_send.called
    request = mock_send.call_args[0][0]
    assert request["type"] == "permission_request"
    assert request["tool_name"] == "Bash"

    # Simulate user approval
    backend.resolve_permission(request["request_id"], {
        "approved": True,
        "modified_input": None,
        "reason": None
    })

    # Wait for callback to complete
    result = await task

    # Verify approval
    assert result.behavior == "allow"

@pytest.mark.asyncio
async def test_timeout_denies():
    """Permission request should auto-deny after 60 seconds."""
    mock_send = AsyncMock()
    backend = ClaudeAgentSDKBackend(
        project_path="/test",
        permission_mode="plan",
        ws_send_callback=mock_send
    )

    # Trigger callback without responding
    result = await backend._can_use_tool_callback(
        "Bash", {"command": "ls"}, None
    )

    # Should timeout and deny
    assert result.behavior == "deny"
    assert "timeout" in result.message.lower()

@pytest.mark.asyncio
async def test_ask_user_question_flow():
    """AskUserQuestion should display questions and collect answers."""
    mock_send = AsyncMock()
    backend = ClaudeAgentSDKBackend(
        project_path="/test",
        permission_mode="plan",
        ws_send_callback=mock_send
    )

    questions = [
        {
            "question": "Which library?",
            "header": "Library",
            "options": [
                {"label": "React", "description": "UI library"},
                {"label": "Vue", "description": "Framework"}
            ],
            "multiSelect": False
        }
    ]

    # Trigger callback
    task = asyncio.create_task(
        backend._can_use_tool_callback(
            "AskUserQuestion",
            {"questions": questions},
            None
        )
    )

    # Wait for request
    await asyncio.sleep(0.1)

    # Verify request sent
    assert mock_send.called
    request = mock_send.call_args[0][0]
    assert request["request_type"] == "ask_user_question"

    # Simulate user answer
    backend.resolve_permission(request["request_id"], {
        "approved": True,
        "answers": {"Which library?": "React"}
    })

    # Wait for callback
    result = await task

    # Verify answer format
    assert result.behavior == "allow"
    assert result.updated_input["answers"]["Which library?"] == "React"
```

### Integration Tests

**File**: `tests/test_permission_integration.py`

```python
import asyncio
import pytest
from src.ui_chatter.main import app
from fastapi.testclient import TestClient
from fastapi import WebSocket

@pytest.mark.asyncio
async def test_permission_flow_end_to_end():
    """Test full permission approval flow from backend to UI."""
    # Setup WebSocket connection
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as websocket:
            # Send handshake
            websocket.send_json({
                "type": "handshake",
                "permission_mode": "plan"
            })

            # Receive session confirmation
            response = websocket.receive_json()
            assert response["type"] == "session_created"
            session_id = response["session_id"]

            # Send chat message that requires tool execution
            websocket.send_json({
                "type": "chat",
                "message": "Create a test.txt file"
            })

            # Should receive permission_request
            request = websocket.receive_json()
            assert request["type"] == "permission_request"
            assert request["tool_name"] == "Bash"

            # Send approval
            websocket.send_json({
                "type": "permission_response",
                "request_id": request["request_id"],
                "approved": True
            })

            # Should receive tool execution and response
            messages = []
            while True:
                msg = websocket.receive_json()
                messages.append(msg)
                if msg.get("type") == "response_chunk" and msg.get("done"):
                    break

            # Verify tool executed
            tool_activities = [m for m in messages if m["type"] == "tool_activity"]
            assert any(t["tool_name"] == "Bash" for t in tool_activities)
```

### Manual Testing Checklist

**Prerequisites:**
- [ ] Backend running with `permission_mode="plan"`
- [ ] Extension loaded in Chrome
- [ ] WebSocket connection established

**Test Scenarios:**

| # | Scenario | Steps | Expected Result |
|---|----------|-------|-----------------|
| 1 | Bash approval | Send "Create test.txt file" | Modal shows `touch test.txt`, clicking Allow creates file |
| 2 | Dangerous command | Send "Delete all .tmp files" | Modal shows ⚠️ for `rm` command |
| 3 | File write | Send "Write 'hello' to test.txt" | Modal shows file path and content preview |
| 4 | File edit | Send "Change 'hello' to 'world'" | Modal shows file path with old/new strings |
| 5 | AskUserQuestion | Send "Help me choose a library" | Modal shows radio buttons with options |
| 6 | Multi-select | Claude asks multi-choice question | Modal shows checkboxes, allows multiple selections |
| 7 | Timeout | Don't respond for 60s | Modal auto-closes, Claude receives denial |
| 8 | Keyboard shortcuts | Press Enter | Approves request |
| 9 | Keyboard shortcuts | Press Escape | Denies request |
| 10 | Denial flow | Click "Deny" | Claude adapts and tries different approach |
| 11 | Bypass mode | Set `bypassPermissions` | No modal appears, tools execute automatically |
| 12 | Connection loss | Disconnect during request | Timeout triggers denial after 60s |

---

## Implementation Checklist

### Phase 1: Backend Permission Callback
**Estimated: 4-6 hours**

- [ ] Add `PermissionRequestManager` class to `claude_agent_sdk.py`
  - [ ] Use `uuid.uuid4()` for request IDs (not counter)
- [ ] Add `ws_send_callback` parameter to `ClaudeAgentSDKBackend.__init__`
- [ ] Add `shutdown()` method to ClaudeAgentSDKBackend
- [ ] Update `session_manager` to call shutdown before backend recreation
- [ ] Implement `_can_use_tool_callback` method
- [ ] Implement `_request_permission_from_ui` method
  - [ ] Add try/except for ws_send_callback
- [ ] Implement `_handle_ask_user_question` method
- [ ] Add `resolve_permission` method
- [ ] Update `handle_chat` to pass `can_use_tool` to SDK
- [ ] Write unit tests for permission callback
- [ ] Test bypass mode (auto-approve)
- [ ] Test timeout handling
- [ ] Test WebSocket disconnection during pending request
- [ ] Verify shutdown cleanup with unit tests

### Phase 2: WebSocket Protocol Extensions
**Estimated: 2-3 hours**

- [ ] Add `PermissionRequest` model to `messages.py`
- [ ] Add `PermissionResponse` model to `messages.py`
- [ ] Add `permission_response` handler in `main.py` WebSocket loop
- [ ] Pass `ws_send_callback` when creating backend instances
- [ ] Test message routing from backend to UI
- [ ] Test message routing from UI to backend
- [ ] Verify request/response matching via request_id

### Phase 3: UI Permission Modal
**Estimated: 6-8 hours**

- [ ] Add permission modal HTML to `sidepanel.html`
- [ ] Add permission modal CSS styles
- [ ] Implement `handlePermissionRequest` function
- [ ] Implement `showToolPermission` function
  - [ ] Update to call `startPermissionTimer(Math.max(58, timeoutSeconds - 2))`
- [ ] Implement `formatToolInput` function (with tool-specific formatting)
- [ ] Implement `startPermissionTimer` function
  - [ ] Document timer synchronization strategy (58s client / 60s server)
- [ ] Implement `respondToPermission` function
- [ ] Implement `showAskUserQuestion` function
- [ ] Implement `collectQuestionAnswers` function
- [ ] Add event listeners for allow/deny buttons
- [ ] Add keyboard shortcuts (Enter/Escape)
- [ ] Test tool approval UI with Bash commands
- [ ] Test dangerous command highlighting
- [ ] Test AskUserQuestion UI with radio buttons
- [ ] Test AskUserQuestion UI with checkboxes
- [ ] Test countdown timer and timeout behavior
- [ ] Verify client timer is 58s while server timeout is 60s
- [ ] Test near-timeout responses (at 57s, 58s, 59s)

### Phase 4: Integration Testing
**Estimated: 3-4 hours**

- [ ] Write integration tests for full flow
- [ ] Test with actual Claude Agent SDK
- [ ] Test permission approval flow
- [ ] Test permission denial flow
- [ ] Test AskUserQuestion flow
- [ ] Test timeout behavior
- [ ] Test keyboard shortcuts
- [ ] Test concurrent requests (if implemented)
- [ ] Test edge cases (connection loss, mode switching)

### Phase 5: Documentation & Polish
**Estimated: 2-3 hours**

- [ ] Add inline code documentation
- [ ] Update user-facing documentation
- [ ] Add JSDoc comments for JavaScript functions
- [ ] Document permission mode behavior differences
- [ ] Add troubleshooting guide for common issues
- [ ] Create demo video or screenshots
- [ ] Review accessibility (keyboard navigation, screen readers)
- [ ] Performance testing (modal render time, memory usage)

**Total: 17-24 hours**

---

## Security Considerations

| Concern | Risk Level | Mitigation |
|---------|-----------|------------|
| **Permission bypass** | High | SDK enforces permission mode, backend validates requests |
| **Command injection** | High | Display-only in UI, backend doesn't execute modified commands (future feature) |
| **XSS in tool parameters** | Medium | Sanitize all user-generated content before rendering |
| **Timeout abuse** | Low | 60s hardcoded timeout prevents indefinite waiting |
| **Request forgery** | Low | UUID request IDs prevent response mismatching and collisions |
| **WebSocket hijacking** | Medium | Existing origin validation + Chrome extension security |
| **Backend recreation leak** | Low | Shutdown method cleans up pending requests |

**Recommendations:**
1. **Input Sanitization**: Always sanitize tool parameters before displaying in UI
2. **Request ID Validation**: Verify request_id exists before resolving
3. **Timeout Enforcement**: Never allow infinite waiting periods
4. **Backend Cleanup**: Always call `shutdown()` before backend recreation
5. **Audit Logging**: Log all permission requests and responses (future enhancement)

---

## Performance Considerations

| Metric | Target | Measurement |
|--------|--------|-------------|
| Modal render time | < 100ms | Time from permission_request to modal visible |
| Timer accuracy | ±1s | Countdown timer should be accurate to 1 second |
| Memory overhead | < 1MB per request | PermissionRequestManager memory usage |
| WebSocket latency | < 50ms | Round-trip time for permission messages |
| Concurrent requests | Up to 5 queued | Without UI degradation |

**Optimization Strategies:**
- **Lazy rendering**: Only render modal when needed
- **Request cleanup**: Immediately cleanup completed requests
- **Timer efficiency**: Use single interval, avoid creating multiple timers
- **DOM reuse**: Reuse modal DOM elements instead of recreating

---

## Future Enhancements

### 1. Remember Decisions
Add "Don't ask again for this tool" checkbox to modal. Store decisions in `chrome.storage.local` and auto-approve matching future requests.

```javascript
// Example storage format
{
  "permission_rules": {
    "Bash:ls": "allow",
    "Bash:rm -rf*": "deny",
    "Write:/tmp/*": "allow"
  }
}
```

### 2. Advanced Edit UI
Inline diff editor for Edit operations with syntax highlighting and ability to modify before approving.

```
┌─────────────────────────────────────────────┐
│ Edit: src/app.js                            │
├─────────────────────────────────────────────┤
│ - const name = 'Alice'                      │
│ + const name = 'Bob'                        │
│                                             │
│ [Modify] [Cancel] [Apply]                   │
└─────────────────────────────────────────────┘
```

### 3. Permission History
Log all permission requests and user decisions with timestamps. Display in settings page.

```
Recent Permissions:
- 2026-01-30 10:05 - Bash: ls /tmp          ✓ Allowed
- 2026-01-30 10:03 - Write: test.txt        ✓ Allowed
- 2026-01-30 10:01 - Bash: rm -rf files/    ✗ Denied
```

### 4. Rule-Based Auto-Approval
Settings page to configure allow-list patterns for automatic approval without prompts.

```
Auto-Approve Rules:
☑ Read on *.md files
☑ Bash: ls, pwd, cat
☐ Write to /tmp/*
☐ All Edit operations
```

### 5. Background Notifications
When sidepanel is closed, show Chrome notification for permission requests.

```
Chrome Notification:
"Claude needs permission"
"Tool: Bash - Command: ls /tmp"
[Allow] [Deny]
```

### 6. Concurrent Request Queue
Show "3 more permissions waiting" indicator and queue multiple requests.

```
┌─────────────────────────────────────────────┐
│ 🔐 Permission Required (1 of 3)       60s   │
├─────────────────────────────────────────────┤
│ Tool: Bash                                  │
│ ...                                         │
└─────────────────────────────────────────────┘
```

---

## Edge Cases & Error Handling

### 1. Backend Recreation During Pending Request

**Scenario**: User updates permission mode while permission request is pending.

**Problem**:
- `session_manager.update_permission_mode()` recreates backend
- Old backend with pending request is discarded
- SDK query hangs indefinitely waiting for response

**Detection**:
- `PermissionRequestManager` holds unreachable pending requests
- SDK query never completes

**Solution**:
1. Call `backend.shutdown()` before recreating (implemented in Section 1.3)
2. Shutdown resolves all pending requests with denial
3. SDK queries complete cleanly with "Backend shutdown" message

**Implementation**:
```python
# session_manager.py
async def update_permission_mode(self, session_id: str, new_mode: str):
    session = self.sessions.get(session_id)

    # Cleanup old backend before recreating
    if hasattr(session.backend, 'shutdown'):
        await session.backend.shutdown()

    # Recreate with new mode
    session.backend = self._create_backend(...)
```

**Alternative Approaches Considered**:
- Block permission mode changes during active queries (too restrictive)
- Queue permission mode changes (unnecessary complexity)
- Persist pending requests across backends (wrong - requests are ephemeral)

### 2. No WebSocket Connection
**Scenario**: Backend tries to request permission but WebSocket is disconnected.

**Behavior**:
- Backend checks `if not self.ws_send_callback` before creating request
- Auto-denies permission with error message
- Logs warning

**Fallback**: Claude receives denial and adapts approach.

### 3. WebSocket Disconnection During Request
**Scenario**: User disconnects while permission request is pending.

**Detection**: WebSocket send fails or connection closed event.

**Cleanup**:
- Clear all pending permission events in `PermissionRequestManager`
- Set all events with timeout error
- Backend receives denial results
- Try/except wrapper in `_request_permission_from_ui` handles send failures gracefully

### 4. Multiple Concurrent Requests
**Scenario**: Claude requests permission for multiple tools simultaneously.

**Current Implementation**: All requests are sent, UI shows one at a time (FIFO queue).

**Future Enhancement**: Queue indicator showing "3 more permissions waiting".

### 5. Permission Mode Switch Mid-Stream
**Scenario**: User changes permission mode while request is pending.

**Behavior**:
- Backend shutdown is called before recreation (see Section 1.3)
- Shutdown resolves all pending requests with denial
- In-flight requests complete cleanly with "Backend shutdown" message
- New backend instance starts fresh with updated mode

### 6. User Closes Sidepanel
**Scenario**: User closes sidepanel while permission request is active.

**Detection**: Background script still connected, sidepanel unloaded.

**Fallback**:
- Request times out after 60 seconds
- Backend receives denial
- Future enhancement: Chrome notification

### 7. Timeout Exactly at 60 Seconds
**Scenario**: User clicks "Allow" at exactly 60 seconds.

**Handling**:
- Race condition between timer and user action
- Client timer is 58s while server is 60s (2-second buffer)
- This ensures user response arrives before server timeout
- First to complete wins (timer sets event first, ignores subsequent response)
- Cleanup prevents memory leaks

### 8. Invalid Request ID
**Scenario**: UI sends permission_response with invalid request_id.

**Behavior**:
- Backend checks if request_id exists in pending requests
- Logs warning if not found
- Ignores invalid response
- Original request continues waiting (will timeout)

---

## References

### Documentation
- [Claude Agent SDK Permissions](https://platform.claude.com/docs/en/agent-sdk/permissions)
- [Claude Agent SDK User Input](https://platform.claude.com/docs/en/agent-sdk/user-input)
- [Claude Agent SDK Python Reference](https://platform.claude.com/docs/en/agent-sdk/python)
- [Chrome Extension WebSocket API](https://developer.chrome.com/docs/extensions/reference/sockets/)

### Related Tech Specs
- [TS-0005: Claude Agent SDK Integration](./TS-0005-claude-agent-sdk-integration.md) - Initial SDK backend implementation
- [TS-0006: SDK Streaming and UX Improvements](./TS-0006-sdk-streaming-and-ux-improvements.md) - Multi-channel streaming protocol
- [TS-0008: SDK Session Management Refactoring](./TS-0008-sdk-session-management-refactoring.md) - Session lifecycle and SDK integration

### Code References
- Backend: `src/ui_chatter/backends/claude_agent_sdk.py`
- WebSocket Handler: `src/ui_chatter/main.py`
- Message Models: `src/ui_chatter/models/messages.py`
- Frontend UI: `poc/extension/sidepanel.js`, `poc/extension/sidepanel.html`
- Background Script: `poc/extension/background.js`

---

## Appendix: Permission Modes Comparison

| Mode | Tool Execution | Permission Callback | Use Case |
|------|---------------|---------------------|----------|
| `bypassPermissions` | Auto-approve all | Not called | Development, trusted environments |
| `plan` | Block all | Called for every tool | Planning phase, review before execution |
| `acceptEdits` | Auto-approve edits, ask for others | Called for non-edit tools | Trust edits, review commands |
| `dontAsk` | Auto-approve all (deprecated) | Not called | Legacy mode, use bypassPermissions instead |
| `delegate` | Delegate to callback | Called for every tool | Custom approval logic |

---

## Status History

| Date | Status | Notes |
|------|--------|-------|
| 2026-01-30 | DRAFT | Initial tech spec created from implementation plan |
| 2026-01-31 | UPDATED | Incorporated CTO architectural review findings: UUID request IDs, backend shutdown, WebSocket error handling, timer synchronization |

---

## Glossary

| Term | Definition |
|------|------------|
| **Permission Callback** | Async function triggered by SDK when tool execution requires user approval |
| **Permission Request** | WebSocket message sent from backend to UI requesting user approval |
| **Permission Response** | WebSocket message sent from UI to backend with user's approval decision |
| **AskUserQuestion** | Special tool that allows Claude to ask clarifying questions to users |
| **Request ID** | Unique identifier matching responses to requests |
| **Timeout** | 60-second limit for user to respond before auto-denial |
| **Permission Mode** | SDK setting controlling auto-approval behavior |
| **Tool Approval** | User approval for specific tool execution |
| **canUseTool** | SDK callback interface for permission handling |
