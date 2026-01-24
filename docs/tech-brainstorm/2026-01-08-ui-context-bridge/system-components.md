# System Components & Interactions

## Architecture Overview (Revised)

```
┌─────────────────┐  stores   ┌─────────────────┐  calls   ┌─────────────────┐
│     Chrome      │──────────▶│   Local MCP     │◀─────────│   Claude Code   │
│    Extension    │  context  │     Server      │  tools   │                 │
│                 │◀──────────│                 │──────────│                 │
│   (Chat UI)     │ responses │  (Relay/Store)  │ responses│  (Agent)        │
└─────────────────┘           └─────────────────┘          └─────────────────┘
```

### Flow

1. **User selects element** → Extension captures DOM + screenshot → stores in MCP server
2. **User types message** in extension chat → stored in MCP server
3. **User triggers Claude Code** → types "ui" or runs a slash command
4. **Claude Code calls** `get_ui_context()` → receives DOM, screenshot, user message
5. **Claude Code** searches codebase, finds component, proposes/applies changes
6. **Claude Code calls** `respond_to_browser(message)` → MCP server stores response
7. **Extension polls** for response → displays in chat panel
8. **Vite/webpack** hot-reloads → user sees changes

---

## Components

### 1. Chrome Extension

#### Content Script
- **Click Mode**: Overlay that highlights elements on hover
- **DOM Extractor**: Captures element context on click
- **Screenshot Capture**: Element screenshot via `html2canvas` or Chrome API

#### Side Panel (Chat UI)
- Shows selected component preview (thumbnail + DOM snippet)
- Chat input for user instructions
- Displays conversation history
- Polls MCP server for agent responses
- Status indicator: "Waiting for response..." / "Claude is working..."

#### Background Service Worker
- Manages WebSocket connection to MCP server
- Handles message routing between content script and side panel

---

### 2. Local MCP Server

#### HTTP/WebSocket Endpoints (for Extension)
```
POST /context      - Store new UI selection
POST /message      - Store user message
GET  /response     - Poll for agent response (long-polling or SSE)
WS   /stream       - Real-time bidirectional (alternative to polling)
```

#### MCP Tools (for Claude Code)
```
get_ui_context()        - Returns current selection + user message
respond_to_browser(msg) - Send response to extension chat
get_conversation()      - Get full conversation history
clear_context()         - Reset current selection
```

#### State Store
- Current UI selection (DOM, screenshot path, metadata)
- Conversation history (user messages + agent responses)
- Session management (could support multiple browser tabs later)

---

### 3. Claude Code Integration

#### Trigger Options
| Method | User Action | Implementation |
|--------|-------------|----------------|
| Keyword | Type "ui" or "check ui" | Agent watches for keyword |
| Slash command | `/ui` | Custom Claude Code command |
| Alias | `ui` in terminal | Shell alias that runs Claude Code with prompt |

#### Agent Behavior
1. Call `get_ui_context()`
2. Receive: DOM snippet, screenshot, user instruction
3. Search codebase for matching component (fuzzy match)
4. Present findings / propose changes
5. Apply changes if approved
6. Call `respond_to_browser()` with summary

---

## Decisions Made

- ✅ Option C architecture: Chat in browser, manual Claude Code trigger
- ✅ Side panel for chat (not popup)
- ✅ Hot reload handled by existing tooling (Vite, webpack)
- ✅ Source mapping: AI fuzzy matching
- ✅ Polling or SSE for response delivery to extension

## Open Questions

- [ ] Polling vs WebSocket vs SSE for extension↔server communication
- [ ] How to handle multi-turn conversations elegantly
- [ ] Screenshot storage: base64 in memory vs temp file path
