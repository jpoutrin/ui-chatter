# API Design & Endpoints

## Communication Protocols

```
Extension ◀──WebSocket──▶ MCP Server ◀──MCP Tools──▶ Claude Code
              (real-time)              (request/response)
```

---

## WebSocket API (Extension ↔ Server)

Connection: `ws://localhost:PORT/ws?sessionId=xxx`

### Extension → Server

```typescript
// Store UI selection
{
  type: "set_context",
  payload: {
    element: {
      tagName: string;
      id?: string;
      classList: string[];
      textContent: string;
      attributes: Record<string, string>;
      boundingBox: { x: number, y: number, width: number, height: number };
    },
    ancestors: Array<{ tagName: string, classList: string[], id?: string }>,
    children?: Array<{ tagName: string, classList: string[], textContent?: string }>,
    page: { url: string, title: string },
    screenshot: string  // base64 PNG
  }
}

// Send user message
{
  type: "user_message",
  payload: {
    contextId: string,
    message: string
  }
}

// Ping/keepalive
{ type: "ping" }
```

### Server → Extension

```typescript
// Acknowledge context stored
{
  type: "context_stored",
  payload: { contextId: string }
}

// Status update from Claude Code
{
  type: "status_update",
  payload: {
    status: "idle" | "thinking" | "searching" | "editing",
    detail?: string
  }
}

// Agent response
{
  type: "agent_response",
  payload: {
    contextId: string,
    message: string,
    isComplete: boolean
  }
}

// Streaming response chunk
{
  type: "agent_response_chunk",
  payload: {
    contextId: string,
    chunk: string
  }
}

// Pong
{ type: "pong" }
```

---

## MCP Tools (Claude Code ↔ Server)

### get_ui_context

Returns current UI selection and pending user message.

```typescript
Parameters: {
  sessionId?: string   // Optional: specific session, defaults to latest in project
}

Returns: {
  sessionId: string,
  contextId: string,
  element: { /* DOM data */ },
  ancestors: [...],
  page: { url: string, title: string },
  screenshotPath: string,  // Local file path
  userMessage: string,
  timestamp: number
}
```

### list_sessions

List all active sessions for current project.

```typescript
Parameters: {}

Returns: {
  sessions: Array<{
    sessionId: string,
    pageUrl: string,
    pageTitle: string,
    lastActive: number,
    hasUnreadMessage: boolean
  }>
}
```

### respond_to_browser

Send response back to extension chat.

```typescript
Parameters: {
  sessionId: string,
  contextId: string,
  message: string,       // Markdown supported
  isComplete: boolean    // false for streaming
}

Returns: { success: true }
```

### update_status

Update the status indicator in extension.

```typescript
Parameters: {
  sessionId: string,
  status: "idle" | "thinking" | "searching" | "editing",
  detail?: string  // e.g., "Searching for Button component..."
}

Returns: { success: true }
```

### get_conversation_history

Get conversation history for context.

```typescript
Parameters: {
  sessionId: string,
  limit?: number  // Default 20
}

Returns: {
  messages: Array<{
    role: "user" | "assistant",
    content: string,
    contextId?: string,
    timestamp: number
  }>
}
```

---

## Storage Structure

```
~/.ui-chatter/
├── registry.json              # sessionId → project path mapping
└── server.pid

your-project/.ui-chatter/
├── sessions/
│   ├── {sessionId-1}.json     # Per-tab context
│   └── {sessionId-2}.json
├── history.db                 # SQLite conversation history
└── screenshots/
    ├── {sessionId-1}_ctx.png
    └── {sessionId-2}_ctx.png
```

---

## Session Management

- **Session ID**: `hash(browserTabId + origin + timestamp)`
- **Default behavior**: `get_ui_context()` returns latest active session in current project
- **Multi-session**: User can run `ui list` then `ui #2` to pick specific session

---

## Decisions Made

- ✅ WebSocket for extension↔server (bidirectional)
- ✅ MCP Tools for Claude Code↔server
- ✅ Project-local storage with central registry
- ✅ Multi-session support with smart defaults
