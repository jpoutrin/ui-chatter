# TS-0004: Session Selection UI for Past Conversations

## Metadata

| Field | Value |
|-------|-------|
| **Tech Spec ID** | TS-0004 |
| **Title** | Session Selection UI for Past Conversations |
| **Status** | IMPLEMENTED |
| **Author** | |
| **Created** | 2026-01-29 |
| **Last Updated** | 2026-01-29 |
| **Decision Ref** | |
| **Related Docs** | TS-0001, TS-0002, TS-0003 |

---

## Executive Summary

### Problem Statement

The current UI Chatter extension lacks the ability to view and switch between past conversation sessions. Users experience:

1. **No conversation history** - When the extension is closed, the current conversation is lost with no way to retrieve it
2. **Single active session** - Only one conversation can exist at a time, forcing users to start over
3. **No session context** - Users can't see what conversations exist or when they last interacted
4. **Poor discoverability** - No way to search or browse previous conversations by topic

**Impact on Users**:
- Users lose context and must repeat questions across sessions
- Cannot reference previous conversations for continuity
- Limited utility compared to native Claude.ai interface which has full conversation history
- Frustrating UX when accidentally closing extension or browser

### Proposed Solution

Implement a **session list UI** with search and selection capabilities, similar to Claude.ai's "Past Conversations" panel. The solution includes:

1. **Session List Panel** - Sidebar displaying all sessions sorted by last activity
2. **Auto-generated Titles** - Session titles extracted from first user message (first 50 chars)
3. **Simple Search** - Text-based search through session titles
4. **Session Switching** - Click any session to load its conversation history
5. **Real-time Updates** - New sessions appear immediately, timestamps update live

**Key Innovation**: Leverage existing `SessionStore` SQLite database with minimal schema changes, add REST API endpoints for session management, and implement lightweight WebSocket protocol for session switching.

### Success Criteria

| Metric | Current | Target | How Measured |
|--------|---------|--------|--------------|
| **Session retrieval** | N/A (no history) | 100% of past sessions | Manual testing |
| **Switch latency** | N/A | < 500ms | Performance profiling |
| **Search accuracy** | N/A | 95%+ relevant results | User testing with 20+ sessions |
| **UI responsiveness** | N/A | No lag with 100+ sessions | Load testing |
| **Session title quality** | N/A | 90%+ meaningful titles | User survey |

### Out of Scope

- Session title editing (auto-generated only)
- Session deletion/archival from UI (backend only)
- Session pinning or favorites
- Full-text search of message content (title-only search)
- Session sharing or export
- Pagination (show all sessions with scroll)
- Message preview in session list

---

## Design Overview

### Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Session Selection Architecture                   │
└────────────────────────────────────────────────────────────────────────┘

┌──────────────────────┐              ┌────────────────────────────────┐
│  Chrome Extension    │              │      FastAPI Backend           │
│                      │              │                                │
│  ┌────────────────┐  │  WebSocket   │  ┌──────────────────────────┐  │
│  │  Side Panel    │  │◄────────────►│  │  WebSocket Handler       │  │
│  │                │  │              │  │  - Session switch        │  │
│  │  • Session list│  │              │  │  - Active session track  │  │
│  │  • Search bar  │  │              │  └──────────────────────────┘  │
│  │  • New session │  │              │                                │
│  │  • Timestamps  │  │  HTTP/REST   │  ┌──────────────────────────┐  │
│  └────────────────┘  │◄────────────►│  │  REST API Endpoints      │  │
│                      │              │  │  GET /sessions           │  │
│  ┌────────────────┐  │              │  │  GET /sessions/:id       │  │
│  │  Background.js │  │              │  │  POST /sessions          │  │
│  │                │  │              │  │  GET /sessions/search    │  │
│  │  • Message     │  │              │  └──────────────────────────┘  │
│  │    routing     │  │              │               │                │
│  │  • Session     │  │              │               ▼                │
│  │    state       │  │              │  ┌──────────────────────────┐  │
│  └────────────────┘  │              │  │  SessionStore (SQLite)   │  │
│                      │              │  │  • sessions table        │  │
└──────────────────────┘              │  │  • title generation      │  │
                                      │  │  • search index          │  │
                                      │  └──────────────────────────┘  │
                                      └────────────────────────────────┘
```

### Data Flow

#### 1. Loading Session List

```
User opens extension
   │
   ▼
Frontend: GET /sessions
   │
   ▼
Backend: SessionStore.get_active_sessions()
   │
   ▼
Backend: Returns JSON array of sessions
   [
     {
       session_id: "uuid",
       title: "How to implement auth...",
       last_activity: "2026-01-29T10:30:00Z",
       created_at: "2026-01-29T09:00:00Z",
       message_count: 15
     },
     ...
   ]
   │
   ▼
Frontend: Renders session list, sorted by last_activity DESC
```

#### 2. Switching Sessions

```
User clicks session in list
   │
   ▼
Frontend: Send WebSocket message
   {
     type: "switch_session",
     session_id: "uuid"
   }
   │
   ▼
Backend: ConnectionManager handles switch
   - Close current session
   - Load new session from SessionStore
   - Resume Claude CLI session if exists
   │
   ▼
Backend: Send confirmation + session data
   {
     type: "session_switched",
     session_id: "uuid",
     session_data: { ... }
   }
   │
   ▼
Frontend: Update UI
   - Clear current messages
   - Load session messages (future: from Claude CLI storage)
   - Update active session indicator
```

#### 3. Creating New Session

```
User clicks "New Conversation" button
   │
   ▼
Frontend: POST /sessions
   {
     project_path: "/path/to/project",
     backend_type: "anthropic-sdk",
     permission_mode: "bypassPermissions"
   }
   │
   ▼
Backend: Create new session
   - Generate UUID
   - Save to SessionStore
   - Initialize empty session
   │
   ▼
Backend: Return new session metadata
   {
     session_id: "new-uuid",
     title: "Untitled",
     created_at: "now"
   }
   │
   ▼
Frontend: Switch to new session
```

#### 4. Searching Sessions

```
User types in search box
   │
   ▼
Frontend: Debounce 300ms → GET /sessions/search?q=query
   │
   ▼
Backend: SessionStore.search_sessions(query)
   - WHERE title LIKE '%query%'
   - ORDER BY last_activity DESC
   │
   ▼
Backend: Return matching sessions
   │
   ▼
Frontend: Update filtered list
```

### Key Design Decision: Session Title Generation

| Approach | Pros | Cons | Decision |
|----------|------|------|----------|
| **User-provided title** | Full control, clear naming | Requires extra input, friction | ❌ Not selected |
| **First user message** | Automatic, meaningful | May be too long, needs truncation | ✅ **Selected** |
| **AI-generated summary** | Professional, concise | Requires extra API call, latency | ❌ Not selected |
| **Timestamp-based** | Always unique | Not descriptive | ❌ Not selected |

**Rationale**: Auto-generated titles from first message balance usability and implementation simplicity. Users can immediately identify conversations without extra input. Truncate to 50 characters for UI consistency.

---

## Component Specifications

### 1. Database Schema Changes

#### File: `service/src/ui_chatter/session_store.py`

**Add `title` column to sessions table**:

```python
async def initialize(self) -> None:
    """Initialize database schema (idempotent)."""
    async with self._lock:
        if self._initialized:
            return

        async with aiosqlite.connect(self.db_path) as db:
            await db.execute("""
                CREATE TABLE IF NOT EXISTS sessions (
                    session_id TEXT PRIMARY KEY,
                    project_path TEXT NOT NULL,
                    backend_type TEXT NOT NULL,
                    permission_mode TEXT,
                    status TEXT NOT NULL DEFAULT 'active',
                    first_message_sent INTEGER NOT NULL DEFAULT 0,
                    title TEXT DEFAULT 'Untitled',  -- NEW COLUMN
                    created_at TEXT NOT NULL,
                    last_activity TEXT NOT NULL
                )
            """)

            # Add index for title search
            await db.execute("""
                CREATE INDEX IF NOT EXISTS idx_sessions_title
                ON sessions(title)
            """)

            await db.execute("""
                CREATE INDEX IF NOT EXISTS idx_sessions_status
                ON sessions(status)
            """)

            await db.execute("""
                CREATE INDEX IF NOT EXISTS idx_sessions_last_activity
                ON sessions(last_activity)
            """)

            await db.commit()
```

**Add title update method**:

```python
async def set_session_title(self, session_id: str, title: str) -> None:
    """Set or update session title."""
    await self.initialize()

    # Truncate title to 100 characters max
    truncated_title = title[:100] if len(title) > 100 else title

    async with aiosqlite.connect(self.db_path) as db:
        await db.execute(
            """
            UPDATE sessions
            SET title = ?, last_activity = ?
            WHERE session_id = ?
            """,
            (truncated_title, datetime.now().isoformat(), session_id),
        )
        await db.commit()
        logger.info(f"Updated title for session {session_id}: {truncated_title}")
```

**Add search method**:

```python
async def search_sessions(self, query: str) -> List[Dict[str, Any]]:
    """Search sessions by title."""
    await self.initialize()

    # Escape SQL LIKE special characters
    escaped_query = query.replace("%", "\\%").replace("_", "\\_")
    search_pattern = f"%{escaped_query}%"

    async with aiosqlite.connect(self.db_path) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """
            SELECT * FROM sessions
            WHERE status = 'active'
              AND title LIKE ? ESCAPE '\\'
            ORDER BY last_activity DESC
            LIMIT 50
            """,
            (search_pattern,),
        ) as cursor:
            rows = await cursor.fetchall()
            return [dict(row) for row in rows]
```

**Modify `get_active_sessions()` to include title**:

```python
async def get_active_sessions(self) -> List[Dict[str, Any]]:
    """Get all active sessions for recovery."""
    await self.initialize()

    async with aiosqlite.connect(self.db_path) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """
            SELECT
                session_id,
                title,
                project_path,
                backend_type,
                permission_mode,
                created_at,
                last_activity,
                first_message_sent
            FROM sessions
            WHERE status = 'active'
            ORDER BY last_activity DESC
            """
        ) as cursor:
            rows = await cursor.fetchall()
            return [dict(row) for row in rows]
```

### 2. Backend REST API

#### File: `service/src/ui_chatter/main.py` (currently empty)

**FastAPI application with session endpoints**:

```python
"""FastAPI application for UI Chatter backend."""

import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, List

from ui_chatter.session_store import SessionStore
from ui_chatter.websocket import ConnectionManager
from ui_chatter.config import get_config

logger = logging.getLogger(__name__)
config = get_config()

# Initialize session store
session_store = SessionStore(config.project_path)
connection_manager = ConnectionManager()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifespan context manager for startup/shutdown."""
    await session_store.initialize()
    logger.info("UI Chatter backend started")
    yield
    logger.info("UI Chatter backend shutdown")


app = FastAPI(title="UI Chatter Backend", lifespan=lifespan)

# Enable CORS for extension
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Extension origin
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ==================== Models ====================

class SessionCreate(BaseModel):
    """Request to create a new session."""
    project_path: str
    backend_type: str = "anthropic-sdk"
    permission_mode: Optional[str] = "bypassPermissions"


class SessionResponse(BaseModel):
    """Session metadata response."""
    session_id: str
    title: str
    project_path: str
    backend_type: str
    permission_mode: Optional[str]
    created_at: str
    last_activity: str
    first_message_sent: bool


# ==================== Endpoints ====================

@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "healthy"}


@app.get("/sessions", response_model=List[SessionResponse])
async def list_sessions():
    """Get all active sessions."""
    sessions = await session_store.get_active_sessions()
    return sessions


@app.get("/sessions/{session_id}", response_model=SessionResponse)
async def get_session(session_id: str):
    """Get session by ID."""
    session = await session_store.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


@app.post("/sessions", response_model=SessionResponse)
async def create_session(session_data: SessionCreate):
    """Create a new session."""
    import uuid
    from datetime import datetime

    session_id = str(uuid.uuid4())
    now = datetime.now()

    await session_store.save_session(
        session_id=session_id,
        project_path=session_data.project_path,
        backend_type=session_data.backend_type,
        permission_mode=session_data.permission_mode,
        created_at=now,
        status="active",
    )

    return {
        "session_id": session_id,
        "title": "Untitled",
        "project_path": session_data.project_path,
        "backend_type": session_data.backend_type,
        "permission_mode": session_data.permission_mode,
        "created_at": now.isoformat(),
        "last_activity": now.isoformat(),
        "first_message_sent": False,
    }


@app.get("/sessions/search", response_model=List[SessionResponse])
async def search_sessions(q: str):
    """Search sessions by title."""
    if not q or len(q.strip()) == 0:
        return await list_sessions()

    sessions = await session_store.search_sessions(q.strip())
    return sessions


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket endpoint for real-time communication."""
    # See websocket.py for implementation
    pass
```

### 3. WebSocket Protocol Extension

#### File: `service/src/ui_chatter/websocket.py`

**Add session switch handler**:

```python
async def handle_switch_session(self, session_id: str, new_session_id: str) -> dict:
    """
    Handle session switching.

    Args:
        session_id: Current session ID
        new_session_id: Target session ID to switch to

    Returns:
        Session switched confirmation message
    """
    # Validate new session exists
    session_data = await self.session_store.get_session(new_session_id)
    if not session_data:
        return {
            "type": "error",
            "code": "session_not_found",
            "message": f"Session {new_session_id} not found",
        }

    # Close current session (if any)
    if session_id in self.active_connections:
        logger.info(f"Closing current session {session_id}")
        await self.disconnect(session_id)

    # Load new session
    logger.info(f"Switching to session {new_session_id}")

    return {
        "type": "session_switched",
        "session_id": new_session_id,
        "session_data": session_data,
    }
```

**Add to message handler** (in main WebSocket loop):

```python
if message_type == "switch_session":
    new_session_id = data.get("session_id")
    if not new_session_id:
        await websocket.send_json({
            "type": "error",
            "message": "Missing session_id in switch_session message"
        })
        continue

    response = await connection_manager.handle_switch_session(
        session_id=session_id,
        new_session_id=new_session_id
    )
    await websocket.send_json(response)
```

### 4. Frontend Session List UI

#### File: `poc/extension/sidepanel.html`

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>UI Chatter</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      height: 100vh;
      overflow: hidden;
      background: #f9fafb;
    }

    /* ==================== Session Sidebar ==================== */
    .sidebar {
      width: 280px;
      background: #1f2937;
      color: white;
      display: flex;
      flex-direction: column;
      border-right: 1px solid #374151;
    }

    .sidebar-header {
      padding: 16px;
      border-bottom: 1px solid #374151;
    }

    .sidebar-title {
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 12px;
    }

    .new-session-btn {
      width: 100%;
      padding: 10px;
      background: #3b82f6;
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.2s;
    }

    .new-session-btn:hover {
      background: #2563eb;
    }

    .search-container {
      padding: 12px 16px;
      border-bottom: 1px solid #374151;
    }

    .search-input {
      width: 100%;
      padding: 8px 12px;
      background: #374151;
      border: 1px solid #4b5563;
      border-radius: 6px;
      color: white;
      font-size: 14px;
      outline: none;
    }

    .search-input::placeholder {
      color: #9ca3af;
    }

    .search-input:focus {
      border-color: #3b82f6;
      box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
    }

    .sessions-list {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
    }

    .session-item {
      padding: 12px;
      margin-bottom: 6px;
      background: #374151;
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s;
      border: 2px solid transparent;
    }

    .session-item:hover {
      background: #4b5563;
    }

    .session-item.active {
      background: #3b82f6;
      border-color: #60a5fa;
    }

    .session-title {
      font-size: 14px;
      font-weight: 500;
      margin-bottom: 4px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .session-meta {
      font-size: 12px;
      color: #9ca3af;
    }

    .session-item.active .session-meta {
      color: #e0e7ff;
    }

    .sessions-empty {
      padding: 24px;
      text-align: center;
      color: #9ca3af;
      font-size: 14px;
    }

    /* ==================== Chat Area ==================== */
    .chat-container {
      flex: 1;
      display: flex;
      flex-direction: column;
      background: white;
    }

    .chat-header {
      padding: 16px 24px;
      border-bottom: 1px solid #e5e7eb;
      background: white;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .chat-title {
      font-size: 18px;
      font-weight: 600;
      color: #111827;
    }

    .settings-btn {
      padding: 8px 16px;
      background: #f3f4f6;
      color: #374151;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      cursor: pointer;
      transition: background 0.2s;
    }

    .settings-btn:hover {
      background: #e5e7eb;
    }

    .messages {
      flex: 1;
      overflow-y: auto;
      padding: 24px;
    }

    .message {
      margin-bottom: 16px;
      padding: 12px 16px;
      border-radius: 8px;
      max-width: 100%;
    }

    .message.user {
      background: #e0e7ff;
      color: #1e40af;
      margin-left: auto;
    }

    .message.assistant {
      background: #f3f4f6;
      color: #1f2937;
    }

    .message.status {
      background: #fef3c7;
      color: #92400e;
      font-size: 13px;
    }

    .message.error {
      background: #fee2e2;
      color: #991b1b;
      font-size: 13px;
    }

    .input-container {
      padding: 16px 24px;
      border-top: 1px solid #e5e7eb;
      background: white;
    }

    .input-wrapper {
      display: flex;
      gap: 12px;
    }

    .message-input {
      flex: 1;
      padding: 10px 16px;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      font-size: 14px;
      font-family: inherit;
      resize: none;
      outline: none;
      min-height: 44px;
      max-height: 200px;
    }

    .message-input:focus {
      border-color: #3b82f6;
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
    }

    .send-btn {
      padding: 10px 24px;
      background: #3b82f6;
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.2s;
      white-space: nowrap;
    }

    .send-btn:hover:not(:disabled) {
      background: #2563eb;
    }

    .send-btn:disabled {
      background: #9ca3af;
      cursor: not-allowed;
    }

    /* Scrollbar styling */
    .sessions-list::-webkit-scrollbar,
    .messages::-webkit-scrollbar {
      width: 8px;
    }

    .sessions-list::-webkit-scrollbar-track {
      background: #1f2937;
    }

    .sessions-list::-webkit-scrollbar-thumb {
      background: #4b5563;
      border-radius: 4px;
    }

    .messages::-webkit-scrollbar-track {
      background: #f9fafb;
    }

    .messages::-webkit-scrollbar-thumb {
      background: #d1d5db;
      border-radius: 4px;
    }
  </style>
</head>
<body>
  <!-- Session Sidebar -->
  <div class="sidebar">
    <div class="sidebar-header">
      <h1 class="sidebar-title">Past Conversations</h1>
      <button class="new-session-btn" id="newSessionBtn">+ New Conversation</button>
    </div>

    <div class="search-container">
      <input
        type="text"
        class="search-input"
        id="sessionSearch"
        placeholder="Search sessions..."
      />
    </div>

    <div class="sessions-list" id="sessionsList">
      <div class="sessions-empty">No conversations yet</div>
    </div>
  </div>

  <!-- Chat Area -->
  <div class="chat-container">
    <div class="chat-header">
      <h2 class="chat-title" id="chatTitle">Untitled</h2>
      <button class="settings-btn" id="settingsBtn">Settings</button>
    </div>

    <div class="messages" id="messages">
      <div class="message status">Connected. Start a conversation!</div>
    </div>

    <div class="input-container">
      <div class="input-wrapper">
        <textarea
          class="message-input"
          id="messageInput"
          placeholder="Type your message..."
          rows="1"
        ></textarea>
        <button class="send-btn" id="sendBtn">Send</button>
      </div>
    </div>
  </div>

  <script src="sidepanel.js"></script>
</body>
</html>
```

### 5. Frontend JavaScript Logic

#### File: `poc/extension/sidepanel.js`

```javascript
// ==================== State Management ====================

let state = {
  currentSessionId: null,
  sessions: [],
  websocket: null,
  isConnected: false,
  searchQuery: '',
};

// ==================== DOM Elements ====================

const elements = {
  // Sidebar
  newSessionBtn: document.getElementById('newSessionBtn'),
  sessionSearch: document.getElementById('sessionSearch'),
  sessionsList: document.getElementById('sessionsList'),

  // Chat
  chatTitle: document.getElementById('chatTitle'),
  settingsBtn: document.getElementById('settingsBtn'),
  messages: document.getElementById('messages'),
  messageInput: document.getElementById('messageInput'),
  sendBtn: document.getElementById('sendBtn'),
};

// ==================== API Functions ====================

async function fetchSessions() {
  try {
    const response = await fetch('http://localhost:3456/sessions');
    if (!response.ok) throw new Error('Failed to fetch sessions');
    const sessions = await response.json();
    state.sessions = sessions;
    renderSessionsList();
  } catch (error) {
    console.error('Error fetching sessions:', error);
    addMessage('error', 'Failed to load sessions');
  }
}

async function searchSessions(query) {
  try {
    const url = query
      ? `http://localhost:3456/sessions/search?q=${encodeURIComponent(query)}`
      : 'http://localhost:3456/sessions';

    const response = await fetch(url);
    if (!response.ok) throw new Error('Failed to search sessions');
    const sessions = await response.json();
    state.sessions = sessions;
    renderSessionsList();
  } catch (error) {
    console.error('Error searching sessions:', error);
  }
}

async function createNewSession() {
  try {
    const settings = await chrome.storage.local.get(['projectPath']);
    const response = await fetch('http://localhost:3456/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_path: settings.projectPath || process.cwd(),
        backend_type: 'anthropic-sdk',
        permission_mode: 'bypassPermissions',
      }),
    });

    if (!response.ok) throw new Error('Failed to create session');
    const newSession = await response.json();

    // Add to sessions list and switch to it
    state.sessions.unshift(newSession);
    renderSessionsList();
    await switchToSession(newSession.session_id);

    addMessage('status', 'New conversation started');
  } catch (error) {
    console.error('Error creating session:', error);
    addMessage('error', 'Failed to create new session');
  }
}

// ==================== WebSocket Functions ====================

function connectWebSocket() {
  const ws = new WebSocket('ws://localhost:3456/ws');

  ws.onopen = () => {
    console.log('WebSocket connected');
    state.isConnected = true;
    state.websocket = ws;

    // Send handshake
    ws.send(JSON.stringify({
      type: 'handshake',
      permission_mode: 'bypassPermissions',
    }));
  };

  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      handleServerMessage(message);
    } catch (error) {
      console.error('Failed to parse message:', error);
    }
  };

  ws.onclose = () => {
    console.log('WebSocket disconnected');
    state.isConnected = false;
    state.websocket = null;
    addMessage('status', 'Disconnected. Reconnecting...');

    // Reconnect after 3 seconds
    setTimeout(connectWebSocket, 3000);
  };

  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
    addMessage('error', 'Connection error');
  };
}

async function switchToSession(sessionId) {
  if (!state.websocket || !state.isConnected) {
    addMessage('error', 'Not connected to server');
    return;
  }

  // Send switch session message
  state.websocket.send(JSON.stringify({
    type: 'switch_session',
    session_id: sessionId,
  }));

  // Update UI immediately
  state.currentSessionId = sessionId;
  const session = state.sessions.find(s => s.session_id === sessionId);
  if (session) {
    elements.chatTitle.textContent = session.title;
  }
  renderSessionsList();
}

function handleServerMessage(message) {
  switch (message.type) {
    case 'session_switched':
      console.log('Session switched:', message.session_id);
      elements.messages.innerHTML = '';
      addMessage('status', 'Session loaded');
      break;

    case 'response_chunk':
      if (message.done) {
        addMessage('status', 'Response complete');
      } else {
        appendToLastMessage(message.content);
      }
      break;

    case 'status':
      addMessage('status', message.detail || message.status);
      break;

    case 'error':
      addMessage('error', `Error: ${message.message}`);
      break;

    default:
      console.log('Unknown message type:', message.type);
  }
}

// ==================== UI Rendering ====================

function renderSessionsList() {
  const filteredSessions = state.searchQuery
    ? state.sessions.filter(s =>
        s.title.toLowerCase().includes(state.searchQuery.toLowerCase())
      )
    : state.sessions;

  if (filteredSessions.length === 0) {
    elements.sessionsList.innerHTML = '<div class="sessions-empty">No sessions found</div>';
    return;
  }

  elements.sessionsList.innerHTML = filteredSessions
    .map(session => {
      const isActive = session.session_id === state.currentSessionId;
      const lastActivity = new Date(session.last_activity);
      const timeAgo = formatTimeAgo(lastActivity);

      return `
        <div
          class="session-item ${isActive ? 'active' : ''}"
          data-session-id="${session.session_id}"
        >
          <div class="session-title">${escapeHtml(session.title)}</div>
          <div class="session-meta">${timeAgo}</div>
        </div>
      `;
    })
    .join('');

  // Add click handlers
  elements.sessionsList.querySelectorAll('.session-item').forEach(item => {
    item.addEventListener('click', () => {
      const sessionId = item.dataset.sessionId;
      switchToSession(sessionId);
    });
  });
}

function addMessage(type, content) {
  const messageDiv = document.createElement('div');
  messageDiv.className = `message ${type}`;
  messageDiv.textContent = content;
  elements.messages.appendChild(messageDiv);
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function appendToLastMessage(content) {
  const lastMessage = elements.messages.lastElementChild;
  if (lastMessage && lastMessage.classList.contains('assistant')) {
    lastMessage.textContent += content;
  } else {
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message assistant';
    messageDiv.textContent = content;
    elements.messages.appendChild(messageDiv);
  }
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

// ==================== Utility Functions ====================

function formatTimeAgo(date) {
  const seconds = Math.floor((new Date() - date) / 1000);

  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d`;

  return date.toLocaleDateString();
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Debounce function for search
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
}

// ==================== Event Listeners ====================

elements.newSessionBtn.addEventListener('click', createNewSession);

elements.sessionSearch.addEventListener('input', debounce((e) => {
  state.searchQuery = e.target.value.trim();
  searchSessions(state.searchQuery);
}, 300));

elements.sendBtn.addEventListener('click', sendMessage);

elements.messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

elements.settingsBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

function sendMessage() {
  const message = elements.messageInput.value.trim();
  if (!message || !state.isConnected) return;

  // Send message via WebSocket
  state.websocket.send(JSON.stringify({
    type: 'chat',
    message: message,
    context: {},
  }));

  // Display user message
  addMessage('user', message);
  elements.messageInput.value = '';

  // Update session title if this is the first message
  updateSessionTitleIfNeeded(message);
}

async function updateSessionTitleIfNeeded(firstMessage) {
  if (!state.currentSessionId) return;

  const currentSession = state.sessions.find(s => s.session_id === state.currentSessionId);
  if (currentSession && currentSession.title === 'Untitled') {
    // Generate title from first message (first 50 chars)
    const title = firstMessage.slice(0, 50) + (firstMessage.length > 50 ? '...' : '');

    // Update locally
    currentSession.title = title;
    elements.chatTitle.textContent = title;
    renderSessionsList();

    // Note: Backend will update title when it receives first message
  }
}

// ==================== Initialization ====================

async function initialize() {
  console.log('Initializing UI Chatter sidepanel');

  // Connect WebSocket
  connectWebSocket();

  // Load sessions
  await fetchSessions();

  // Load current session from storage
  const stored = await chrome.storage.local.get(['currentSessionId']);
  if (stored.currentSessionId) {
    state.currentSessionId = stored.currentSessionId;
    const session = state.sessions.find(s => s.session_id === stored.currentSessionId);
    if (session) {
      elements.chatTitle.textContent = session.title;
    }
    renderSessionsList();
  }
}

// Start the app
initialize();
```

---

## API Specifications

### REST API Endpoints

#### GET /sessions

**Description**: List all active sessions

**Response**: `200 OK`
```json
[
  {
    "session_id": "uuid",
    "title": "How to implement auth...",
    "project_path": "/path/to/project",
    "backend_type": "anthropic-sdk",
    "permission_mode": "bypassPermissions",
    "created_at": "2026-01-29T09:00:00Z",
    "last_activity": "2026-01-29T10:30:00Z",
    "first_message_sent": true
  }
]
```

#### GET /sessions/:id

**Description**: Get session by ID

**Parameters**:
- `id` (path): Session UUID

**Response**: `200 OK`
```json
{
  "session_id": "uuid",
  "title": "Session title",
  "project_path": "/path/to/project",
  "backend_type": "anthropic-sdk",
  "permission_mode": "bypassPermissions",
  "created_at": "2026-01-29T09:00:00Z",
  "last_activity": "2026-01-29T10:30:00Z",
  "first_message_sent": true
}
```

**Error**: `404 Not Found`
```json
{
  "detail": "Session not found"
}
```

#### POST /sessions

**Description**: Create a new session

**Request Body**:
```json
{
  "project_path": "/path/to/project",
  "backend_type": "anthropic-sdk",
  "permission_mode": "bypassPermissions"
}
```

**Response**: `200 OK`
```json
{
  "session_id": "new-uuid",
  "title": "Untitled",
  "project_path": "/path/to/project",
  "backend_type": "anthropic-sdk",
  "permission_mode": "bypassPermissions",
  "created_at": "2026-01-29T11:00:00Z",
  "last_activity": "2026-01-29T11:00:00Z",
  "first_message_sent": false
}
```

#### GET /sessions/search?q=query

**Description**: Search sessions by title

**Parameters**:
- `q` (query): Search query string

**Response**: `200 OK`
```json
[
  {
    "session_id": "uuid",
    "title": "Matching session title",
    ...
  }
]
```

### WebSocket Messages

#### Client → Server: Switch Session

```json
{
  "type": "switch_session",
  "session_id": "target-uuid"
}
```

#### Server → Client: Session Switched

```json
{
  "type": "session_switched",
  "session_id": "target-uuid",
  "session_data": {
    "session_id": "target-uuid",
    "title": "Session title",
    "project_path": "/path/to/project",
    ...
  }
}
```

#### Server → Client: Error

```json
{
  "type": "error",
  "code": "session_not_found",
  "message": "Session abc-123 not found"
}
```

---

## Example User Flows

### Flow 1: First Time User

```
1. User opens extension
   → Sees empty "Past Conversations" sidebar
   → Chat shows "Connected. Start a conversation!"

2. User types "How do I implement auth?"
   → Message sent via WebSocket
   → Session created with title "How do I implement auth?"
   → Session appears in sidebar (active state)
   → Chat title updates

3. User closes and reopens extension
   → Session list loads from backend
   → Active session restored
   → Messages persist
```

### Flow 2: Switching Between Sessions

```
1. User has 5 active sessions in sidebar
   → Sorted by last_activity (most recent first)

2. User clicks on older session "Setting up database"
   → WebSocket sends switch_session message
   → Backend closes current session
   → Backend loads target session
   → Frontend clears chat and shows "Session loaded"
   → Session highlighted in sidebar
   → Chat title updates

3. User continues conversation
   → New messages added to selected session
   → last_activity timestamp updates
   → Session moves to top of list
```

### Flow 3: Searching Sessions

```
1. User has 50+ sessions

2. User types "auth" in search box
   → 300ms debounce delay
   → GET /sessions/search?q=auth
   → Backend searches titles with LIKE '%auth%'
   → Returns 8 matching sessions

3. Frontend filters and displays matches
   → Only matching sessions shown
   → Search box shows "auth"

4. User clears search
   → All sessions reappear
   → Sorted by last_activity
```

### Flow 4: Creating New Session

```
1. User clicks "+ New Conversation"
   → POST /sessions
   → Backend creates session with UUID
   → Returns session metadata (title: "Untitled")

2. Frontend switches to new session
   → WebSocket sends switch_session
   → New session appears at top of sidebar (active)
   → Chat clears, ready for first message

3. User sends first message
   → Message sent via WebSocket
   → Backend updates session title (first 50 chars of message)
   → Frontend updates title in sidebar and chat header
```

---

## Security Considerations

| Concern | Mitigation |
|---------|------------|
| **XSS in session titles** | All titles escaped with `escapeHtml()` before rendering |
| **SQL injection in search** | Parameterized queries with `?` placeholders, LIKE special chars escaped |
| **CORS bypass** | Backend restricts origins to extension ID only |
| **Session hijacking** | Sessions tied to project path, no cross-project access |
| **WebSocket message injection** | JSON schema validation on all incoming messages |
| **Path traversal in project_path** | Backend validates paths exist and are absolute |

---

## Testing Plan

### Unit Tests

**File**: `service/tests/test_session_store.py`

```python
async def test_set_session_title():
    """Test setting session title."""
    store = SessionStore("/tmp/test-project")
    await store.initialize()

    session_id = "test-uuid"
    await store.save_session(
        session_id=session_id,
        project_path="/tmp/test",
        backend_type="anthropic-sdk",
    )

    await store.set_session_title(session_id, "My test session")

    session = await store.get_session(session_id)
    assert session["title"] == "My test session"

async def test_search_sessions():
    """Test searching sessions by title."""
    store = SessionStore("/tmp/test-project")
    await store.initialize()

    # Create test sessions
    await store.save_session("s1", "/tmp", "sdk")
    await store.set_session_title("s1", "Authentication flow")

    await store.save_session("s2", "/tmp", "sdk")
    await store.set_session_title("s2", "Database setup")

    await store.save_session("s3", "/tmp", "sdk")
    await store.set_session_title("s3", "User authentication")

    # Search for "auth"
    results = await store.search_sessions("auth")
    assert len(results) == 2
    assert all("auth" in s["title"].lower() for s in results)

async def test_title_truncation():
    """Test that long titles are truncated."""
    store = SessionStore("/tmp/test-project")
    await store.initialize()

    long_title = "A" * 150
    await store.save_session("s1", "/tmp", "sdk")
    await store.set_session_title("s1", long_title)

    session = await store.get_session("s1")
    assert len(session["title"]) == 100
```

### Integration Tests

| # | Scenario | Steps | Expected Result |
|---|----------|-------|-----------------|
| 1 | Load sessions on startup | Open extension | Sessions list appears, sorted by last_activity |
| 2 | Create new session | Click "+ New Conversation" | New session appears with "Untitled", becomes active |
| 3 | Switch sessions | Click different session in list | Chat clears, session becomes active, title updates |
| 4 | Search sessions | Type "auth" in search | Only matching sessions appear |
| 5 | Clear search | Clear search input | All sessions reappear |
| 6 | First message updates title | Send first message in new session | Title updates to first 50 chars |
| 7 | Session persists | Close and reopen extension | Active session restored |
| 8 | WebSocket reconnect | Kill backend, restart | Extension reconnects, sessions reload |

### Manual Testing Checklist

- [ ] Sessions load correctly on extension open
- [ ] New session button creates session with "Untitled"
- [ ] Clicking session switches active session
- [ ] Search filters sessions by title
- [ ] Clearing search shows all sessions
- [ ] First message updates session title
- [ ] Session list sorted by last_activity (newest first)
- [ ] Active session highlighted in sidebar
- [ ] Chat title matches active session
- [ ] WebSocket reconnects after disconnect
- [ ] 100+ sessions load without lag
- [ ] Search works with special characters
- [ ] XSS protection works (try `<script>alert(1)</script>` in title)

---

## Implementation Plan

### Phase 1: Database & Backend API (4-5 hours)

- [ ] Add `title` column to sessions table in `session_store.py`
- [ ] Add `title` index for search performance
- [ ] Implement `set_session_title()` method
- [ ] Implement `search_sessions()` method
- [ ] Test schema migration on existing database
- [ ] Create FastAPI app in `main.py`
- [ ] Implement GET /sessions endpoint
- [ ] Implement GET /sessions/:id endpoint
- [ ] Implement POST /sessions endpoint
- [ ] Implement GET /sessions/search endpoint
- [ ] Test all endpoints with curl/Postman

### Phase 2: WebSocket Session Switching (2-3 hours)

- [ ] Add `handle_switch_session()` to ConnectionManager
- [ ] Add switch_session message handler to WebSocket loop
- [ ] Add session_switched response message
- [ ] Test session switching with mock WebSocket client
- [ ] Handle edge cases (session not found, already active)

### Phase 3: Frontend UI (5-6 hours)

- [ ] Create sidepanel.html with sidebar layout
- [ ] Add CSS styling for session list, search, buttons
- [ ] Implement session list rendering in sidepanel.js
- [ ] Add search input with debouncing
- [ ] Add new session button handler
- [ ] Add session click handlers for switching
- [ ] Implement WebSocket connection in frontend
- [ ] Handle session_switched messages
- [ ] Test UI responsiveness with many sessions

### Phase 4: Title Generation Logic (2-3 hours)

- [ ] Add title update when first message sent
- [ ] Truncate long titles to 50 chars for display
- [ ] Update session title in backend on first message
- [ ] Update session title in frontend immediately
- [ ] Test with various message lengths

### Phase 5: Integration & Testing (4-5 hours)

- [ ] End-to-end test: create → message → switch → search
- [ ] Test with 0, 1, 10, 100 sessions
- [ ] Test search with empty query, special chars
- [ ] Test WebSocket reconnection scenarios
- [ ] Performance testing (load time, switch time)
- [ ] Browser console error checking
- [ ] Security testing (XSS, SQL injection attempts)
- [ ] Bug fixes and polish

**Total Estimate**: 17-22 hours of implementation work

---

## Rollback Plan

If session selection causes issues:

1. **Immediate Rollback**:
   - Revert `main.py` to empty state
   - Remove `title` column migration (sessions still work without it)
   - Restore original `sidepanel.html` (empty)
   - Extension continues to work in single-session mode

2. **Partial Rollback**:
   - Keep backend API but disable frontend UI
   - Sessions still tracked, but no UI to switch
   - Can re-enable when issues resolved

3. **Data Migration**:
   - Existing sessions without titles → default to "Untitled"
   - No data loss, backwards compatible

---

## Open Questions

1. **Should we load message history from Claude CLI storage?**
   - Currently messages not persisted in our backend
   - Claude CLI may store messages, need to investigate
   - Action: Research Claude CLI session storage format

2. **What happens to session when Claude CLI subprocess crashes?**
   - Need robust error handling
   - Should auto-restart Claude CLI on next message
   - Action: Test crash scenarios

3. **Performance with 1000+ sessions?**
   - Current design: load all sessions at once
   - May need pagination if >1000 sessions common
   - Action: Monitor usage patterns, add pagination if needed

4. **Session title conflicts?**
   - Multiple sessions with similar first messages
   - Should we append timestamp or counter?
   - Action: Test with duplicate titles, evaluate UX

---

## Appendix

### References

- [Claude API Documentation](https://docs.anthropic.com/claude/reference)
- [Chrome Extension WebSocket API](https://developer.chrome.com/docs/extensions/reference/)
- [FastAPI Documentation](https://fastapi.tiangolo.com/)
- [SQLite FTS5 Documentation](https://www.sqlite.org/fts5.html)

### Glossary

| Term | Definition |
|------|------------|
| **Session** | A single conversation thread with Claude, identified by UUID |
| **Session Store** | SQLite database storing session metadata (not messages) |
| **Session Switching** | Closing current session and loading a different one |
| **Active Session** | Currently displayed and interacted-with session |
| **Session Title** | Auto-generated label from first user message (50 chars) |

### Related Documents

- [TS-0001: ACP Browser Integration POC](./TS-0001-acp-browser-integration-poc.md)
- [TS-0002: Agent SDK MVP Implementation](./TS-0002-agent-sdk-mvp-implementation.md)
- [TS-0003: Structured LLM Response Protocol](./TS-0003-structured-llm-response-protocol.md)

---

## Status History

| Date | Status | Notes |
|------|--------|-------|
| 2026-01-29 | DRAFT | Initial specification created |
| 2026-01-29 | IMPLEMENTED | All components implemented: session_store, REST API, WebSocket, sidepanel UI |
