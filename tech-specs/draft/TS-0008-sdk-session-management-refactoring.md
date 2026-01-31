---
tech_spec_id: TS-0008
title: SDK-Centric Session Management Refactoring
status: DRAFT
decision_ref:
author:
created: 2026-01-30
last_updated: 2026-01-30
related_docs: TS-0004, TS-0005, TS-0006
---

# TS-0008: SDK-Centric Session Management Refactoring

## Executive Summary

This spec documents the refactoring of UI Chatter's session management to maximize delegation to the Claude Agent SDK, addressing critical conversation continuity issues and simplifying the architecture. The current implementation does not pass `session_id` to the SDK, causing every request to start a fresh conversation. This refactoring enables proper multi-turn conversations, removes duplication between our SessionStore and SDK storage, and completes missing features from TS-0004 (Session Selection UI).

**Key Changes**:
- Pass SDK `session_id` parameter to enable conversation continuity (CRITICAL)
- Simplify session management (remove AgentSession class, on-demand backend creation)
- Complete TS-0004 REST endpoints (search, session switching, title generation)
- Deprecate SessionRepository in favor of SDK-native message history

**Architecture Evolution**:
- **Current**: Service tracks session state, SDK treated as stateless (broken multi-turn)
- **Target**: SDK owns session state, service manages UI metadata only

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

### Current Architecture (Broken Conversation Continuity)

```
Extension --> WebSocket --> SessionManager --> ClaudeAgentSDKBackend
                                │                       │
                                │                       └─> SDK query() WITHOUT session_id ❌
                                │
                                ├─> SessionStore (SQLite)
                                └─> SessionRepository (reads Claude Code storage) ⚠️ REDUNDANT
```

**Problems**:
1. **No session_id passed to SDK** - Every request starts fresh, losing conversation context
2. **Dual session storage** - SessionStore + SDK storage (redundant)
3. **AgentSession class overhead** - Tracks stateless backend instances unnecessarily
4. **SessionRepository redundancy** - Reading SDK storage when SDK can provide directly

### Target Architecture (SDK-Centric)

```
Extension --> WebSocket --> SessionManager --> ClaudeAgentSDKBackend (on-demand)
                                │                       │
                                │                       └─> SDK query() WITH session_id ✅
                                │                           └─> Maintains conversation history
                                │
                                └─> SessionStore (UI metadata ONLY: title, status, timestamps)
```

**Solutions**:
1. **Pass session_id to SDK** - Enables conversation continuity
2. **Single source of truth** - SDK owns session state, SessionStore owns UI metadata
3. **On-demand backend creation** - No tracking, reduced memory
4. **Delegate to SDK** - Message history, session persistence, tool execution

### Component Responsibilities

| Layer | Responsible For | Delegates to SDK |
|-------|----------------|------------------|
| **SessionStore** | UI metadata (title, status, timestamps) | Session state, messages |
| **SessionManager** | Session lifecycle, metadata updates | Conversation context |
| **ClaudeAgentSDKBackend** | Protocol transformation | Session persistence, tool execution |
| **Claude Agent SDK** | Session state, message history, tools | (owns these) |

---

## Detailed Specifications

### Phase 1: SDK Session Integration (CRITICAL - 3-4 hours)

**Objective**: Enable conversation continuity by passing `session_id` to Claude Agent SDK

#### 1.1 Database Schema Changes

**File**: `service/src/ui_chatter/session_store.py`

Add `sdk_session_id` column:
```sql
-- Migration: Add sdk_session_id column
ALTER TABLE sessions ADD COLUMN sdk_session_id TEXT;

-- Updated schema
CREATE TABLE sessions (
    session_id TEXT PRIMARY KEY,      -- UI Chatter session ID
    sdk_session_id TEXT,               -- ✅ NEW: Maps to Claude SDK session
    title TEXT DEFAULT 'Untitled',
    status TEXT DEFAULT 'active',
    created_at TEXT NOT NULL,
    last_activity TEXT NOT NULL
);

-- Index for SDK session lookups
CREATE INDEX idx_sessions_sdk_session_id ON sessions(sdk_session_id);
```

Add methods:
```python
async def get_sdk_session_id(self, session_id: str) -> Optional[str]:
    """Get SDK session_id for a UI Chatter session."""
    async with aiosqlite.connect(self.db_path) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT sdk_session_id FROM sessions WHERE session_id = ?",
            (session_id,)
        ) as cursor:
            row = await cursor.fetchone()
            return row["sdk_session_id"] if row else None

async def set_sdk_session_id(
    self, session_id: str, sdk_session_id: str
) -> None:
    """Link UI Chatter session to SDK session."""
    async with aiosqlite.connect(self.db_path) as db:
        await db.execute(
            "UPDATE sessions SET sdk_session_id = ? WHERE session_id = ?",
            (sdk_session_id, session_id)
        )
        await db.commit()
```

#### 1.2 Backend Integration

**File**: `service/src/ui_chatter/backends/claude_agent_sdk.py`

Update constructor and handle_chat:
```python
class ClaudeAgentSDKBackend(AgentBackend):
    def __init__(
        self,
        project_path: str,
        permission_mode: str = "bypassPermissions",
        sdk_session_id: Optional[str] = None,  # ✅ NEW
        **kwargs
    ):
        super().__init__(project_path)
        self.permission_mode = permission_mode
        self.sdk_session_id = sdk_session_id  # ✅ NEW
        self.allowed_tools = ["Read", "Write", "Edit", "Bash", "Glob", "Grep"]

    async def handle_chat(
        self,
        context: CapturedContext,
        message: str,
        is_first_message: bool = False,  # Deprecated - SDK handles via session_id
        screenshot_path: Optional[str] = None,
        cancel_event: Optional[asyncio.Event] = None,
    ) -> AsyncGenerator[dict, None]:
        # ... existing stream control ...

        prompt = self._build_prompt(context, message, screenshot_path)

        # ✅ CRITICAL CHANGE: Pass session_id to SDK
        async for msg in query(
            prompt=prompt,
            options=ClaudeAgentOptions(
                session_id=self.sdk_session_id,  # ✅ NEW: Enables multi-turn
                allowed_tools=self.allowed_tools,
                permission_mode=self.permission_mode,
                cwd=self.project_path,
            )
        ):
            # ... existing message processing ...
```

#### 1.3 Session Creation

**File**: `service/src/ui_chatter/session_manager.py`

Update create_session:
```python
async def create_session(
    self, session_id: str, permission_mode: str = None
) -> dict:
    """Create session with linked SDK session_id."""
    import uuid

    # Generate SDK session_id
    sdk_session_id = str(uuid.uuid4())

    # Save to store
    await self.session_store.save_session(
        session_id=session_id,
        sdk_session_id=sdk_session_id,
        title="Untitled",
        status="active"
    )

    logger.info(
        f"Created session {session_id} with SDK session {sdk_session_id}"
    )

    return {
        "session_id": session_id,
        "sdk_session_id": sdk_session_id
    }
```

#### 1.4 Testing

**Critical Test**: Conversation Continuity
```python
async def test_conversation_continuity():
    """Verify SDK maintains context across messages."""
    # Create session
    session = await session_manager.create_session("test-session")

    # First message
    async for msg in session_manager.handle_chat(
        session_id="test-session",
        context=empty_context,
        message="My name is Alice"
    ):
        pass  # Consume stream

    # Second message - should remember
    responses = []
    async for msg in session_manager.handle_chat(
        session_id="test-session",
        context=empty_context,
        message="What's my name?"
    ):
        if msg["type"] == "response_chunk":
            responses.append(msg["content"])

    response_text = "".join(responses)
    assert "Alice" in response_text, "SDK should remember previous context"
```

**Verification Steps**:
1. Send: "My name is Alice"
2. Send: "What's my name?"
3. Verify: Response contains "Alice"
4. Check: Messages in `~/.claude/projects/{hash}/{sdk_session_id}.jsonl`

---

### Phase 2: Simplify Session Management (3-4 hours)

**Objective**: Remove over-engineering and duplication

#### 2.1 Remove AgentSession Class

**File**: `service/src/ui_chatter/session_manager.py`

```python
# BEFORE (lines 17-46):
class AgentSession:
    """Represents an active agent session."""
    session_id: str
    project_path: str       # ❌ Duplicated in SessionStore
    backend: AgentBackend   # ❌ Tracked but stateless
    permission_mode: str    # ❌ Duplicated in SessionStore
    first_message_sent: bool  # ❌ Duplicated in SessionStore
    last_activity: datetime
    # ... methods ...

# AFTER:
# Class removed entirely
```

#### 2.2 Simplify SessionManager

```python
class SessionManager:
    def __init__(self, ...):
        # BEFORE:
        # self.sessions: Dict[str, AgentSession] = {}

        # AFTER:
        self.sessions: Dict[str, dict] = {}  # Metadata only

    async def handle_chat(
        self, session_id: str, context: CapturedContext, message: str,
        screenshot_path: Optional[str] = None,
        cancel_event: Optional[asyncio.Event] = None
    ) -> AsyncGenerator[dict, None]:
        """Handle chat by creating backend on-demand."""

        # Load session metadata
        session = await self.session_store.get_session(session_id)
        if not session:
            raise ValueError(f"Session {session_id} not found")

        # Create backend on-demand (NOT tracked)
        backend = ClaudeAgentSDKBackend(
            project_path=self.project_path,
            permission_mode=session.get("permission_mode", self.permission_mode),
            sdk_session_id=session["sdk_session_id"]
        )

        # Stream response
        async for msg in backend.handle_chat(
            context, message, screenshot_path=screenshot_path,
            cancel_event=cancel_event
        ):
            yield msg

        # Update last_activity
        await self.session_store.update_last_activity(session_id)

    async def cleanup_session(self, session_id: str) -> None:
        """Cleanup session resources (simplified)."""
        # No backend shutdown needed (on-demand creation)
        if session_id in self.sessions:
            del self.sessions[session_id]
```

#### 2.3 Remove Redundant Schema Columns (Later Phase)

```sql
-- After SDK integration fully validated
ALTER TABLE sessions DROP COLUMN backend_type;      -- Always claude-agent-sdk
ALTER TABLE sessions DROP COLUMN first_message_sent; -- SDK handles this
ALTER TABLE sessions DROP COLUMN project_path;       -- Global config
ALTER TABLE sessions DROP COLUMN permission_mode;    -- Can be per-request
```

---

### Phase 3: Complete TS-0004 Features (4-5 hours)

**Objective**: Wire missing session selection UI features

#### 3.1 Session Search Endpoint

**File**: `service/src/ui_chatter/main.py`

```python
@app.get("/sessions/search")
async def search_sessions(q: str):
    """Search sessions by title."""
    if not q or len(q.strip()) == 0:
        return await list_sessions()

    sessions = await session_manager.session_store.search_sessions(q.strip())

    # Enrich with message counts (optional)
    enriched = []
    for session in sessions:
        # Message count from SDK storage if needed
        enriched.append(session)

    return {"sessions": enriched}
```

Note: `search_sessions()` already exists in SessionStore (line 306-329 of session_store.py)

#### 3.2 Session Switching via WebSocket

**File**: `service/src/ui_chatter/websocket.py` or `main.py` WebSocket handler

```python
# In main WebSocket message loop (around line 240)
elif data["type"] == "switch_session":
    target_session_id = data.get("session_id")
    if not target_session_id:
        await websocket.send_json({
            "type": "error",
            "message": "Missing session_id in switch_session message"
        })
        continue

    # Validate target session exists
    target_session = await session_manager.session_store.get_session(
        target_session_id
    )
    if not target_session:
        await websocket.send_json({
            "type": "error",
            "code": "session_not_found",
            "message": f"Session {target_session_id} not found"
        })
        continue

    # Cleanup current session
    await session_manager.cleanup_session(session_id)

    # Update active session
    session_id = target_session_id

    # Send confirmation with session data
    await websocket.send_json({
        "type": "session_switched",
        "session_id": target_session_id,
        "session_data": target_session
    })

    logger.info(f"Switched to session {target_session_id}")
```

#### 3.3 Auto-Generate Session Titles

**File**: `service/src/ui_chatter/main.py` WebSocket handler

```python
# After chat response completes (around line 300)
# Check if title needs generation
session = await session_manager.session_store.get_session(session_id)

if session and session.get("title") == "Untitled":
    # Generate title from first 50 chars of user message
    title = message[:50] + ("..." if len(message) > 50 else "")

    await session_manager.session_store.set_session_title(session_id, title)

    # Notify extension
    await connection_manager.send_message(session_id, {
        "type": "session_title_updated",
        "session_id": session_id,
        "title": title
    })

    logger.info(f"Auto-generated title for session {session_id}: {title}")
```

Note: `set_session_title()` already exists in SessionStore (line 284-302)

---

### Phase 4: Deprecate SessionRepository (1-2 hours)

**Objective**: Mark for removal after SDK integration validated

**File**: `service/src/ui_chatter/session_repository.py`

```python
"""
DEPRECATED: This module reads from Claude Code's storage directly.
After TS-0008 implementation, the SDK manages message history via session_id.
This is kept temporarily as a read-only fallback for verification.

TODO: Remove after SDK session integration is fully validated in production.
"""

import warnings

warnings.warn(
    "SessionRepository is deprecated. Use SDK session_id for message history.",
    DeprecationWarning,
    stacklevel=2
)

# Rest of file unchanged
```

**File**: `service/src/ui_chatter/main.py`

Remove message count enrichment from `/sessions` endpoint:
```python
@app.get("/sessions")
async def list_sessions():
    """List all sessions tracked by UI Chatter."""
    if not session_manager.session_store:
        return {"sessions": []}

    active_sessions = await session_manager.session_store.get_active_sessions()

    # REMOVE: Enrichment with message counts
    # (SDK can provide this via session_id if needed)

    return {"sessions": active_sessions}
```

---

## Data Model

### Simplified Session Entity

| Field | Type | Description | Constraints |
|-------|------|-------------|-------------|
| session_id | TEXT | UI Chatter session ID | PRIMARY KEY |
| sdk_session_id | TEXT | Claude SDK session ID | NULL for legacy sessions |
| title | TEXT | Auto-generated from first message | DEFAULT 'Untitled' |
| status | TEXT | active, archived | DEFAULT 'active' |
| created_at | TEXT | ISO 8601 timestamp | NOT NULL |
| last_activity | TEXT | ISO 8601 timestamp | NOT NULL |

### Removed Columns (Phase 2+)

- `backend_type` - Always "claude-agent-sdk"
- `first_message_sent` - SDK handles via session_id
- `project_path` - Global configuration
- `permission_mode` - Can be per-request

### Migration Strategy

**Soft Migration** (Recommended):
1. Add `sdk_session_id` column (nullable)
2. Existing sessions work as-is (sdk_session_id = NULL)
3. On first post-migration message, generate new SDK session
4. No data loss, graceful degradation

**Legacy Session Handling**:
```python
# In SessionManager.handle_chat()
if not session.get("sdk_session_id"):
    # Legacy session - generate new SDK session
    sdk_session_id = str(uuid.uuid4())
    await self.session_store.set_sdk_session_id(session_id, sdk_session_id)
    logger.info(f"Migrated legacy session {session_id} to SDK session {sdk_session_id}")
```

---

## API Specification

### Enhanced REST Endpoints

#### GET /sessions
**Response** (200 OK):
```json
{
  "sessions": [
    {
      "session_id": "ui-chatter-uuid",
      "sdk_session_id": "claude-sdk-uuid",
      "title": "How to implement authentication...",
      "status": "active",
      "created_at": "2026-01-30T10:00:00Z",
      "last_activity": "2026-01-30T12:30:00Z"
    }
  ]
}
```

#### GET /sessions/search?q=query (NEW)
**Query Parameters**:
- `q` (string, required): Search query

**Response** (200 OK):
```json
{
  "sessions": [
    // Filtered sessions matching query
  ]
}
```

### New WebSocket Messages

#### switch_session (Client → Server)
```json
{
  "type": "switch_session",
  "session_id": "target-session-uuid"
}
```

#### session_switched (Server → Client)
```json
{
  "type": "session_switched",
  "session_id": "target-session-uuid",
  "session_data": {
    "session_id": "target-session-uuid",
    "sdk_session_id": "claude-sdk-uuid",
    "title": "Session title",
    "status": "active",
    "created_at": "2026-01-30T10:00:00Z",
    "last_activity": "2026-01-30T12:30:00Z"
  }
}
```

#### session_title_updated (Server → Client)
```json
{
  "type": "session_title_updated",
  "session_id": "session-uuid",
  "title": "Auto-generated title from first message..."
}
```

---

## Testing Strategy

### Critical Test Cases

#### 1. Conversation Continuity
```python
async def test_multi_turn_conversation():
    """SDK should maintain context across messages."""
    session_id = await create_session()

    # First message
    await send_message(session_id, "My name is Alice")

    # Second message
    response = await send_message(session_id, "What's my name?")

    assert "Alice" in response, "Should remember context"
```

#### 2. Session Switching
```python
async def test_session_switching():
    """Switch between sessions without cross-contamination."""
    session_a = await create_session()
    session_b = await create_session()

    await send_message(session_a, "Topic: Python")
    await send_message(session_b, "Topic: JavaScript")

    # Switch back to A
    response = await send_message(session_a, "What topic?")

    assert "Python" in response
    assert "JavaScript" not in response
```

#### 3. Title Auto-Generation
```python
async def test_title_generation():
    """First message should generate session title."""
    session_id = await create_session()

    await send_message(session_id, "How do I implement authentication?")

    session = await get_session(session_id)
    assert session["title"] == "How do I implement authentication?"
```

#### 4. Legacy Session Migration
```python
async def test_legacy_session_migration():
    """Sessions without sdk_session_id should get one."""
    # Create legacy session (no sdk_session_id)
    session_id = await create_legacy_session()

    # Send message
    await send_message(session_id, "Hello")

    # Should have sdk_session_id now
    session = await get_session(session_id)
    assert session["sdk_session_id"] is not None
```

### Performance Tests

| Test | Target | Measurement |
|------|--------|-------------|
| Session creation | < 100ms | Time from handshake to ready |
| Session switching | < 500ms | Time to load and confirm |
| Search 100+ sessions | < 200ms | Query to results |
| Multi-turn latency | < 1s | First token with history |

---

## Implementation Checklist

### Phase 1: SDK Session Integration (CRITICAL)
**Estimated: 3-4 hours**

- [ ] Add `sdk_session_id` column to sessions table
- [ ] Add `get_sdk_session_id()` method to SessionStore
- [ ] Add `set_sdk_session_id()` method to SessionStore
- [ ] Add `sdk_session_id` parameter to ClaudeAgentSDKBackend.__init__
- [ ] Pass `session_id=self.sdk_session_id` in ClaudeAgentOptions
- [ ] Update SessionManager.create_session() to generate SDK session_id
- [ ] Write test_conversation_continuity()
- [ ] Test: Send "My name is Alice", then "What's my name?"
- [ ] Verify: Response contains "Alice"
- [ ] Verify: Messages in ~/.claude/projects/{hash}/{sdk_session_id}.jsonl
- [ ] **CRITICAL: Do not proceed to Phase 2 until conversation continuity works**

### Phase 2: Simplify Session Management
**Estimated: 3-4 hours**

- [ ] Remove AgentSession class from session_manager.py
- [ ] Change SessionManager.sessions to Dict[str, dict]
- [ ] Implement on-demand backend creation in handle_chat()
- [ ] Remove backend tracking and cleanup logic
- [ ] Update session recovery to metadata-only
- [ ] Update tests for new architecture
- [ ] Verify memory usage reduced

### Phase 3: Complete TS-0004 Features
**Estimated: 4-5 hours**

- [ ] Add GET /sessions/search endpoint in main.py
- [ ] Add switch_session WebSocket message handler
- [ ] Implement title auto-generation after first message
- [ ] Add session_title_updated WebSocket message
- [ ] Test search with 20+ sessions
- [ ] Test session switching preserves context
- [ ] Test title generation with various message lengths

### Phase 4: Deprecate SessionRepository
**Estimated: 1-2 hours**

- [ ] Add deprecation warning to session_repository.py
- [ ] Remove message count enrichment from /sessions endpoint
- [ ] Update tests to not rely on SessionRepository
- [ ] Document migration path in comments
- [ ] Keep as read-only fallback for now

### Phase 5: Documentation
**Estimated: 2-3 hours**

- [ ] Add amendment note to TS-0004 referencing TS-0008
- [ ] Update README with SDK-centric architecture
- [ ] Update BACKENDS.md (remove multi-backend references)
- [ ] Document legacy session migration strategy
- [ ] Add architecture decision record (ADR)

**Total: 13-18 hours**

---

## References

### Related Documents

- [TS-0004: Session Selection UI](./TS-0004-session-selection-ui.md) - Original spec (pre-SDK integration)
- [TS-0005: Claude Agent SDK Integration](./TS-0005-claude-agent-sdk-integration.md) - SDK backend implementation
- [TS-0006: SDK Streaming and UX Improvements](./TS-0006-sdk-streaming-and-ux-improvements.md) - Multi-channel protocol
- [CTO Architecture Review](/Users/jeremiepoutrin/.claude/plans/steady-beaming-russell-agent-ac49f46.md) - Detailed analysis and recommendations

### Key Findings from CTO Review

1. **Critical Gap**: `session_id` not passed to SDK → breaks conversation continuity
2. **Over-Engineering**: Dual session storage (SessionStore + SDK) is redundant
3. **Unnecessary Complexity**: AgentSession class tracks stateless backend
4. **Missing Features**: TS-0004 endpoints (search, switch_session) not wired
5. **Recommendation**: Maximize SDK delegation, simplify service layer

### Architecture Principles

| Principle | Application |
|-----------|-------------|
| **Delegate to SDK** | Session state, message history, tool execution |
| **Service owns UI** | Metadata for display (title, status, timestamps) |
| **Stateless backends** | Create on-demand, don't track instances |
| **Single source of truth** | SDK for state, SessionStore for UI metadata |
| **Graceful migration** | Soft migration allows gradual transition |

---

## Appendix: Critical Path

```
Phase 1 (SDK session_id) ──> CRITICAL: Enables conversation continuity
     │
     ├─> Without this: Every message starts fresh conversation
     ├─> With this: Multi-turn conversations work correctly
     │
     └─> BLOCKS all other phases
           │
           ├─> Phase 2: Simplification (depends on Phase 1 working)
           ├─> Phase 3: TS-0004 completion (depends on Phase 1 working)
           └─> Phase 4: Cleanup (depends on Phase 1 validated)
```

**Recommendation**: Implement Phase 1 first, test thoroughly, then proceed to other phases.
