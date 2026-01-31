---
tech_spec_id: TS-0001
title: SDK Message Type Display Enhancement
status: DRAFT
author: TBD
created: 2026-01-31
last_updated: 2026-01-31
decision_ref: N/A
tags: [ui-chatter, sdk, frontend, ux]
---

# TS-0001: SDK Message Type Display Enhancement

## Executive Summary

**Problem:** UI Chatter currently ignores several Claude Agent SDK message types and content blocks, resulting in lost information and poor user experience. Specifically:
- ThinkingBlock (extended thinking) is completely ignored
- Tool inputs/outputs are only shown as summaries
- Mid-stream errors are not detected early
- Several SDK message types have no handlers

**Solution:** Implement comprehensive handling for all SDK message types and content blocks, with focus on:
1. Displaying Claude's thinking process (ThinkingBlock)
2. Showing expandable tool inputs/outputs with full data
3. Early error detection from AssistantMessage.error
4. Logging unhandled message types for debugging

**Impact:**
- Users see Claude's reasoning process
- Better debugging with full tool data visibility
- Faster error feedback (detect auth/rate limit issues immediately)
- Future-proof against new SDK message types

**Timeline:** 2-3 days
- Day 1: Backend changes (message handlers, logging)
- Day 2: Frontend changes (UI components)
- Day 3: Testing and refinement

## Background

### Current State

The UI Chatter backend (`claude_agent_sdk.py`) currently handles:

| SDK Type | Status | What We Extract |
|----------|--------|-----------------|
| `ResultMessage` | ✅ Handled | Final completion signal, error flag |
| `AssistantMessage` | ⚠️ Partial | Text blocks, tool use (not error, model, or thinking) |
| `SystemMessage` | ⚠️ Partial | Only "init" subtype (session ID) |
| `TextBlock` | ✅ Handled | Full text content |
| `ToolUseBlock` | ✅ Handled | Tool name, ID, summary of input |
| `ThinkingBlock` | ❌ **Ignored** | Nothing |
| `UserMessage` | ❌ **Ignored** | Nothing |
| `StreamEvent` | ❌ **Ignored** | Nothing |

### Problems Identified

1. **🔇 ThinkingBlock Ignored**
   - When Claude uses extended thinking, the reasoning is lost
   - No "thinking" indicator in UI
   - Users can't understand Claude's decision process

2. **📊 Limited Tool Visibility**
   - Tool inputs shown as summary only (e.g., "Reading file.py")
   - Full input parameters hidden
   - Tool outputs abbreviated (first 100 chars)
   - Cannot see full file contents, command outputs, etc.

3. **⚠️ Late Error Detection**
   - `AssistantMessage.error` field never checked
   - Auth failures, rate limits detected only at end
   - Poor UX - user waits for response, then sees error

4. **🐛 Potential Bug**
   - Constant `SDK_MSG_TOOL_RESULT = "ToolResultMessage"` may be incorrect
   - `ToolResultMessage` doesn't exist in SDK types
   - Need to investigate actual message type received

### User Impact

**Current Experience:**
- User: "What's Claude thinking about?"
  - Answer: Nothing shown (thinking is hidden)
- User: "What file did Claude read?"
  - Answer: Only sees "Reading config.py" (not the content)
- User: "Why did it fail?"
  - Answer: Waits 30s, then sees generic error (not early auth failure)

**Desired Experience:**
- See "Claude is thinking..." with optional reasoning
- Click tool to expand and see full input/output
- See errors immediately with actionable messages

## Design Overview

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Browser Extension                         │
│  ┌────────────────────────────────────────────────────────┐ │
│  │              Sidepanel UI                              │ │
│  │                                                        │ │
│  │  [Text Response]                                       │ │
│  │  [🧠 Claude is thinking...] ← NEW                     │ │
│  │  [🔧 Tool: Read (click to expand)] ← ENHANCED         │ │
│  │     └─ Input: {"file_path": "config.py"}              │ │
│  │     └─ Output: [Full file content...]                 │ │
│  │  [⚠️ Auth Error - Please login] ← EARLY DETECTION     │ │
│  └────────────────────────────────────────────────────────┘ │
│                            ↑                                 │
│                     WebSocket Messages                       │
└─────────────────────────────────────────────────────────────┘
                             ↑
                     WebSocket Protocol
                             ↓
┌─────────────────────────────────────────────────────────────┐
│                   Python Backend (FastAPI)                   │
│  ┌────────────────────────────────────────────────────────┐ │
│  │         claude_agent_sdk.py                            │ │
│  │                                                        │ │
│  │  async for msg in query(prompt, options):             │ │
│  │                                                        │ │
│  │    if is_assistant_message(msg):                      │ │
│  │      ✅ Check msg.error first ← NEW                   │ │
│  │      for block in msg.content:                        │ │
│  │        if is_text_block(block): ...                   │ │
│  │        elif is_thinking_block(block): ← NEW           │ │
│  │          yield ThinkingMessage(...)                   │ │
│  │        elif is_tool_use_block(block): ← ENHANCED      │ │
│  │          yield ToolActivity(input=full_data)          │ │
│  │                                                        │ │
│  │    elif is_result_message(msg): ...                   │ │
│  │                                                        │ │
│  │    else: ← NEW                                        │ │
│  │      logger.warning("Unhandled: {type(msg)}")         │ │
│  └────────────────────────────────────────────────────────┘ │
│                            ↑                                 │
│                    Claude Agent SDK                          │
└─────────────────────────────────────────────────────────────┘
```

### Message Flow

**New Message Type: "thinking"**
```json
{
  "type": "thinking",
  "content": "Let me analyze this code...\n1. First I'll read the file\n2. Then check imports...",
  "signature": "verified_signature_hash",
  "done": false
}
```

**Enhanced Tool Activity**
```json
{
  "type": "tool_activity",
  "tool_id": "tool_abc123",
  "tool_name": "Read",
  "status": "executing",
  "input_summary": "Reading config.py",
  "input": {  // ← NEW: Full input data
    "file_path": "/app/config.py",
    "offset": 0,
    "limit": 2000
  },
  "timestamp": 1706727840000
}

// Later...
{
  "type": "tool_activity",
  "tool_id": "tool_abc123",
  "tool_name": "Read",
  "status": "completed",
  "output_summary": "150 lines (truncated...)",
  "output": "# Full file content here...",  // ← NEW: Full output
  "duration_ms": 45
}
```

**Early Error Detection**
```json
{
  "type": "error",
  "code": "auth_failed",
  "message": "Authentication failed. Please run 'claude login' in terminal."
}
```

## API Design

### Backend Changes

#### New Message Types

**Python TypedDict:**
```python
# In /src/ui_chatter/models/messages.py

class ThinkingMessage(BaseModel):
    """Claude's thinking process (extended thinking)."""
    type: Literal["thinking"] = "thinking"
    content: str  # The thinking text
    signature: str | None = None  # Verification signature
    done: bool = False
```

**Updated ToolActivity:**
```python
class ToolActivity(BaseModel):
    type: Literal["tool_activity"] = "tool_activity"
    tool_id: str
    tool_name: str
    status: ToolActivityStatus
    input_summary: str | None = None
    input: dict[str, Any] | None = None  # ← NEW: Full input
    output_summary: str | None = None
    output: Any | None = None  # ← NEW: Full output (str, list, etc.)
    duration_ms: int | None = None
    timestamp: int | None = None
```

#### Handler Functions

**ThinkingBlock Handler:**
```python
# In claude_agent_sdk.py, add to message processing loop

elif block_type == "ThinkingBlock":
    thinking_text = getattr(block, 'thinking', None)
    signature = getattr(block, 'signature', None)

    if thinking_text:
        logger.debug(f"[AGENT SDK] Claude is thinking ({len(thinking_text)} chars)")

        yield ThinkingMessage(
            content=thinking_text,
            signature=signature,
            done=False
        ).model_dump()
```

**Error Detection:**
```python
# In claude_agent_sdk.py, at start of AssistantMessage handling

elif is_assistant_message(msg):
    # Check for message-level errors FIRST
    if msg.error:
        error_type = msg.error  # AssistantMessageError literal
        logger.error(f"[AGENT SDK] Assistant message error: {error_type}")

        # Map SDK error types to our error codes
        error_code_map = {
            "authentication_failed": "auth_failed",
            "billing_error": "auth_failed",
            "rate_limit": "rate_limit",
            "invalid_request": "internal",
            "server_error": "internal",
            "unknown": "internal",
        }

        yield {
            "type": "error",
            "code": error_code_map.get(error_type, "internal"),
            "message": self._get_error_message(error_code_map[error_type], Exception(error_type))
        }
        return  # Stop processing this message
```

**Unhandled Message Logger:**
```python
# At end of message processing loop

else:
    # Unknown message type - log for debugging
    msg_type_name = type(msg).__name__
    logger.warning(f"[AGENT SDK] Unhandled message type: {msg_type_name}")

    if is_debug():
        logger.debug(f"[AGENT SDK] Message attributes: {dir(msg)}")
        logger.debug(f"[AGENT SDK] Message data: {vars(msg) if hasattr(msg, '__dict__') else 'N/A'}")
```

### Frontend Changes

#### New TypeScript Types

```typescript
// In /poc/extension/src/types.ts

export interface ThinkingMessage {
  type: 'thinking';
  content: string;
  signature?: string;
  done: boolean;
}

// Update ToolActivityMessage
export interface ToolActivityMessage {
  type: 'tool_activity';
  tool_id: string;
  tool_name: string;
  status: 'executing' | 'completed' | 'failed';
  input_summary?: string;
  input?: Record<string, unknown>;  // ← NEW
  output_summary?: string;
  output?: unknown;  // ← NEW
  duration_ms?: number;
  timestamp?: number;
}

// Update ServerMessage union
export type ServerMessage =
  | HandshakeAckMessage
  | PingMessage
  | ResponseChunkMessage
  | ThinkingMessage  // ← NEW
  | StreamControlMessage
  | ToolActivityMessage
  | StatusMessage
  | ErrorMessage
  | SessionClearedMessage;
```

#### UI Components

**Thinking Indicator:**
```typescript
// In sidepanel.ts

function handleThinkingMessage(msg: ThinkingMessage) {
  const thinkingDiv = document.createElement('div');
  thinkingDiv.className = 'thinking-indicator';
  thinkingDiv.innerHTML = `
    <div class="thinking-header">
      <span class="thinking-icon">🧠</span>
      <span class="thinking-label">Claude is thinking...</span>
      ${msg.signature ? '<span class="verified-badge">✓</span>' : ''}
    </div>
    <details class="thinking-content">
      <summary>View reasoning</summary>
      <pre>${escapeHtml(msg.content)}</pre>
    </details>
  `;
  messagesContainer.appendChild(thinkingDiv);
}
```

**Expandable Tool Activity:**
```typescript
function handleToolActivity(msg: ToolActivityMessage) {
  let toolDiv = document.querySelector(`[data-tool-id="${msg.tool_id}"]`);

  if (!toolDiv) {
    // Create new tool activity element
    toolDiv = document.createElement('div');
    toolDiv.className = 'tool-activity';
    toolDiv.setAttribute('data-tool-id', msg.tool_id);
    messagesContainer.appendChild(toolDiv);
  }

  // Show summary
  let html = `
    <div class="tool-header ${msg.status}">
      <span class="tool-icon">${getToolIcon(msg.tool_name)}</span>
      <span class="tool-name">${msg.tool_name}</span>
      <span class="tool-status">${msg.status}</span>
    </div>
  `;

  // Add expandable input
  if (msg.input) {
    html += `
      <details class="tool-details">
        <summary>Input: ${msg.input_summary || 'View details'}</summary>
        <pre><code>${JSON.stringify(msg.input, null, 2)}</code></pre>
      </details>
    `;
  }

  // Add expandable output
  if (msg.output) {
    const outputPreview = typeof msg.output === 'string'
      ? msg.output.substring(0, 100) + (msg.output.length > 100 ? '...' : '')
      : JSON.stringify(msg.output).substring(0, 100) + '...';

    html += `
      <details class="tool-details">
        <summary>Output: ${msg.output_summary || outputPreview}</summary>
        <pre><code>${typeof msg.output === 'string' ? escapeHtml(msg.output) : JSON.stringify(msg.output, null, 2)}</code></pre>
      </details>
    `;
  }

  toolDiv.innerHTML = html;
}
```

## Data Models

### Python Models

**Location:** `/src/ui_chatter/models/messages.py`

```python
from pydantic import BaseModel, Field
from typing import Literal, Any

class ThinkingMessage(BaseModel):
    """Claude's extended thinking process."""
    type: Literal["thinking"] = "thinking"
    content: str = Field(..., description="Claude's reasoning text")
    signature: str | None = Field(None, description="Verification signature")
    done: bool = Field(False, description="Always false for thinking blocks")

class ToolActivity(BaseModel):
    """Tool execution activity tracking."""
    type: Literal["tool_activity"] = "tool_activity"
    tool_id: str = Field(..., description="Unique tool execution ID")
    tool_name: str = Field(..., description="Tool name (Read, Write, etc.)")
    status: ToolActivityStatus = Field(..., description="Execution status")
    input_summary: str | None = Field(None, description="Human-readable input summary")
    input: dict[str, Any] | None = Field(None, description="Full tool input parameters")
    output_summary: str | None = Field(None, description="Abbreviated output preview")
    output: Any | None = Field(None, description="Full tool output (any type)")
    duration_ms: int | None = Field(None, description="Execution duration in milliseconds")
    timestamp: int | None = Field(None, description="Unix timestamp in milliseconds")
```

### TypeScript Models

**Location:** `/poc/extension/src/types.ts`

```typescript
export interface ThinkingMessage {
  type: 'thinking';
  content: string;
  signature?: string;
  done: boolean;
}

export interface ToolActivityMessage {
  type: 'tool_activity';
  tool_id: string;
  tool_name: string;
  status: 'executing' | 'completed' | 'failed';
  input_summary?: string;
  input?: Record<string, unknown>;
  output_summary?: string;
  output?: unknown;
  duration_ms?: number;
  timestamp?: number;
}
```

## Implementation Plan

### Phase 1: Backend - Logging & Debugging (2 hours)

**Goal:** Add infrastructure to detect unhandled message types

1. **Add message type logging**
   - Track all message types received in debug mode
   - Log unhandled message types with details
   - Add message statistics at end of stream

2. **Investigate ToolResult mystery**
   - Test tool execution with debug logging
   - Identify actual message type received
   - Fix constant or remove if unused

**Files:**
- `/src/ui_chatter/backends/claude_agent_sdk.py`

**Changes:**
```python
# Add to __init__
self.message_stats: dict[str, int] = {}

# In message processing loop, at top
msg_type_name = type(msg).__name__
self.message_stats[msg_type_name] = self.message_stats.get(msg_type_name, 0) + 1

# At end of loop (else clause)
else:
    msg_type_name = type(msg).__name__
    logger.warning(f"[AGENT SDK] Unhandled: {msg_type_name}")
    if is_debug():
        logger.debug(f"  Attributes: {dir(msg)}")

# At stream end
if is_debug():
    logger.debug(f"[AGENT SDK] Message stats: {self.message_stats}")
```

### Phase 2: Backend - ThinkingBlock Handler (2 hours)

**Goal:** Display Claude's extended thinking

1. **Add ThinkingMessage model**
   - Create TypedDict in `messages.py`
   - Export in WebSocketMessage union

2. **Add ThinkingBlock handler**
   - Import `is_thinking_block` TypeGuard (if needed, or use `isinstance`)
   - Handle in message processing loop
   - Yield ThinkingMessage

3. **Test with thinking-enabled prompt**

**Files:**
- `/src/ui_chatter/models/messages.py`
- `/src/ui_chatter/backends/claude_agent_sdk.py`

**Code:**
```python
# In messages.py
class ThinkingMessage(BaseModel):
    type: Literal["thinking"] = "thinking"
    content: str
    signature: str | None = None
    done: bool = False

# In claude_agent_sdk.py
elif block_type == "ThinkingBlock":
    thinking = getattr(block, 'thinking', None)
    sig = getattr(block, 'signature', None)
    if thinking:
        yield ThinkingMessage(
            content=thinking,
            signature=sig
        ).model_dump()
```

### Phase 3: Backend - Error Detection (1 hour)

**Goal:** Catch errors early from AssistantMessage

1. **Add error checking**
   - Check `msg.error` before processing content
   - Map SDK error types to our error codes
   - Yield error message and return early

**Files:**
- `/src/ui_chatter/backends/claude_agent_sdk.py`

**Code:**
```python
elif is_assistant_message(msg):
    # Check for errors FIRST
    if msg.error:
        error_map = {
            "authentication_failed": "auth_failed",
            "rate_limit": "rate_limit",
            # ...
        }
        yield {
            "type": "error",
            "code": error_map.get(msg.error, "internal"),
            "message": self._get_error_message(...)
        }
        return

    # Process content blocks...
```

### Phase 4: Backend - Enhanced Tool Display (2 hours)

**Goal:** Show full tool inputs and outputs

1. **Update ToolActivity model**
   - Add `input` field (dict[str, Any])
   - Add `output` field (Any)

2. **Enhance ToolUseBlock handler**
   - Include full `tool_input` in message
   - Keep summary for backward compatibility

3. **Enhance tool result handler**
   - Include full output content
   - Keep summary for preview

**Files:**
- `/src/ui_chatter/models/messages.py`
- `/src/ui_chatter/backends/claude_agent_sdk.py`

**Code:**
```python
# ToolUseBlock handler
yield ToolActivity(
    tool_id=tool_id,
    tool_name=tool_name,
    status=ToolActivityStatus.EXECUTING,
    input_summary=self._summarize_tool_input(...),
    input=tool_input,  # ← NEW
    timestamp=int(time.time() * 1000)
).model_dump()

# Tool result handler
yield ToolActivity(
    tool_id=tool_id,
    tool_name="",
    status=status,
    output_summary=self._summarize_tool_output(content),
    output=content,  # ← NEW
    duration_ms=None
).model_dump()
```

### Phase 5: Frontend - TypeScript Types (1 hour)

**Goal:** Update TypeScript types to match backend

1. **Add ThinkingMessage interface**
2. **Update ToolActivityMessage interface**
3. **Update ServerMessage union**

**Files:**
- `/poc/extension/src/types.ts`

### Phase 6: Frontend - Thinking UI (2 hours)

**Goal:** Display thinking messages in sidepanel

1. **Add CSS styles**
   - Thinking indicator styles
   - Expandable details
   - Verification badge

2. **Add message handler**
   - Handle "thinking" message type
   - Render thinking indicator
   - Make content expandable

**Files:**
- `/poc/extension/src/sidepanel.ts`
- `/poc/extension/src/styles.css` (if exists)

### Phase 7: Frontend - Tool Expansion (2 hours)

**Goal:** Make tool details expandable

1. **Update tool rendering**
   - Show summary by default
   - Add expand/collapse for input
   - Add expand/collapse for output
   - Syntax highlighting for JSON

2. **Add interaction handlers**
   - Click to expand/collapse
   - Copy button for full content

**Files:**
- `/poc/extension/src/sidepanel.ts`

### Phase 8: Testing & Refinement (2-3 hours)

**Goal:** Verify all features work end-to-end

1. **Backend testing**
   - Run with debug logging
   - Execute tools, check full input/output
   - Trigger thinking, verify ThinkingBlock
   - Trigger errors, verify early detection
   - Check no unhandled message warnings

2. **Frontend testing**
   - Verify thinking indicator appears
   - Verify tool expansion works
   - Verify error messages are actionable
   - Check UI performance

3. **Type checking**
   - Run `make type-check`
   - Fix any type errors

4. **Unit tests**
   - Run `make test`
   - Add tests if needed

## Testing Strategy

### Manual Testing Checklist

**ThinkingBlock:**
- [ ] Send prompt that requires thinking
- [ ] Verify "🧠 Claude is thinking..." appears
- [ ] Verify thinking content is expandable
- [ ] Check signature badge if present

**Tool Display:**
- [ ] Execute Read tool
  - [ ] Verify input shows file path
  - [ ] Click to expand, see full input JSON
  - [ ] Verify output shows file content (not just summary)
- [ ] Execute Bash tool
  - [ ] Verify command shown
  - [ ] Expand output, see full command result
- [ ] Execute Write tool
  - [ ] Verify file path and content shown

**Error Detection:**
- [ ] Trigger auth error (wrong credentials)
  - [ ] Error shown immediately (not after 30s wait)
  - [ ] Message is actionable ("run claude login")
- [ ] Trigger rate limit
  - [ ] Early error detection
  - [ ] Clear error message

**Debugging:**
- [ ] Check server logs for message type stats
- [ ] Verify no "Unhandled message type" warnings
- [ ] Check all message types are logged

### Test Commands

```bash
# Start server with debug logging
uv run ui-chatter --project ../../productvista.fr --debug 2>&1 | tee test.log

# After testing, check logs
grep "Message type stats:" test.log
grep "Unhandled message type:" test.log
grep "ThinkingBlock" test.log
grep "tool_activity" test.log

# Type checking
make type-check

# Unit tests
make test
```

### Test Scenarios

**Scenario 1: Extended Thinking**
```
User: "Analyze this codebase and suggest improvements"
Expected:
1. "🧠 Claude is thinking..." appears
2. Thinking content shows reasoning steps
3. Response follows with suggestions
```

**Scenario 2: Tool Execution with Full Data**
```
User: "Read the config file"
Expected:
1. Tool activity: "Read - executing"
2. Input expandable: {"file_path": "config.py", "limit": 2000}
3. Output expandable: [full file content, not truncated]
```

**Scenario 3: Early Error Detection**
```
User: [Make request with expired auth]
Expected:
1. Error appears within 1-2 seconds
2. Message: "Authentication failed. Please run 'claude login'"
3. No 30-second wait for final ResultMessage
```

## Deployment

### Prerequisites

- Python backend running with updated code
- Browser extension rebuilt with TypeScript changes
- Debug logging enabled for initial rollout

### Rollout Plan

1. **Development Testing** (1 day)
   - Test all features locally
   - Verify no regressions
   - Check performance impact

2. **Documentation Update**
   - Update README with new features
   - Document thinking indicator
   - Document tool expansion UI

3. **Monitoring**
   - Watch for "Unhandled message type" warnings
   - Track new SDK message types discovered
   - Monitor performance (message processing speed)

### Rollback Plan

If issues occur:
1. Backend: Keep old message handlers as fallback
2. Frontend: Gracefully handle missing fields
3. Feature flags: Could add env var to disable new features

## Success Metrics

**Must Have (Complete Success):**
- [ ] ThinkingBlock content appears when Claude uses extended thinking
- [ ] Tool inputs are expandable showing full JSON
- [ ] Tool outputs are expandable showing full content
- [ ] Errors detected early (within 2 seconds, not at stream end)
- [ ] Zero "Unhandled message type" warnings in logs
- [ ] Message type statistics logged in debug mode
- [ ] All existing tests pass
- [ ] Type checking passes (no mypy errors)

**Should Have (High Value):**
- [ ] Thinking content has expand/collapse UI
- [ ] Tool expansion has syntax highlighting
- [ ] Error messages are actionable (link to docs)
- [ ] Performance: No slowdown in message processing

**Nice to Have (Future Enhancement):**
- [ ] Copy button for tool input/output
- [ ] Search within tool output
- [ ] Usage metrics display (optional, deferred)

## Security & Privacy

### Data Exposure

**ThinkingBlock:**
- Thinking content may contain sensitive reasoning
- Should be treated same as response text (ephemeral, not logged)

**Tool Outputs:**
- May contain file contents, API responses, etc.
- Only sent to WebSocket (not persisted)
- Extension should not store tool outputs

**Error Messages:**
- Should not expose credentials or tokens
- Only show sanitized error types

### Validation

- Escape HTML in thinking content (XSS prevention)
- Escape HTML in tool outputs (XSS prevention)
- Validate JSON.stringify doesn't fail on circular refs

## Open Questions

1. **ToolResultMessage Constant**
   - Is this a bug or is there a message type we're missing?
   - Need to test and verify actual type received
   - **Resolution:** Will investigate in Phase 1

2. **Thinking Content Size**
   - How large can ThinkingBlock.thinking get?
   - Should we truncate very long thinking?
   - **Proposed:** Show first 500 chars, expand for more

3. **Tool Output Size Limits**
   - Should we limit output size in WebSocket message?
   - Large file contents could be 100KB+
   - **Proposed:** Send full content, let WebSocket handle limits

4. **UserMessage and StreamEvent**
   - Should we handle these types?
   - What value do they provide?
   - **Decision:** Defer to future if needed

## Appendix

### SDK Type Reference

From `claude_agent_sdk.types.py`:

**Message Types:**
```python
@dataclass
class AssistantMessage:
    content: list[ContentBlock]
    model: str
    parent_tool_use_id: str | None = None
    error: AssistantMessageError | None = None  # ← We don't check this!

@dataclass
class ResultMessage:
    subtype: str
    duration_ms: int
    is_error: bool
    # ... plus usage, cost, etc.

@dataclass
class SystemMessage:
    subtype: str  # "init", etc.
    data: dict[str, Any]
```

**Content Block Types:**
```python
@dataclass
class TextBlock:
    text: str

@dataclass
class ThinkingBlock:
    thinking: str
    signature: str

@dataclass
class ToolUseBlock:
    id: str
    name: str
    input: dict[str, Any]
```

### Related Documentation

- Claude Agent SDK: https://github.com/anthropics/claude-sdk-python
- Extended Thinking: https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking
- UI Chatter Architecture: `/docs/architecture.md` (if exists)

---

**Status**: DRAFT - Ready for review
**Next Steps**: Review with team, then implement Phase 1
