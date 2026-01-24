# Technology Choices

## Final Architecture: Agent SDK Service

```
┌─────────────────┐              ┌─────────────────────────────────────┐
│     Chrome      │              │         Agent SDK Service           │
│    Extension    │──WebSocket──▶│                                     │
│                 │◀─────────────│  ┌─────────────────────────────┐   │
│  - Content      │   responses  │  │     Claude Agent SDK        │   │
│    script       │   + status   │  │  - Uses Claude Code OAuth   │   │
│  - Side panel   │              │  │  - Built-in tools           │   │
│  - DOM capture  │              │  │  - Session management       │   │
└─────────────────┘              │  │  - Streaming responses      │   │
                                 │  └─────────────────────────────┘   │
                                 │                                     │
                                 │  Tools: Read, Edit, Glob, Grep,    │
                                 │         Bash, WebSearch            │
                                 └─────────────────────────────────────┘
```

## Decisions Made

### 1. Chrome Extension
| Component | Choice | Reason |
|-----------|--------|--------|
| Manifest | V3 | Required for new extensions |
| Language | TypeScript | Type safety |
| UI | Side Panel API | Persistent, native Chrome experience |
| Screenshot | html2canvas or Chrome API | Element-level capture |
| Communication | WebSocket | Bidirectional, real-time |

### 2. Backend Service
| Component | Choice | Reason |
|-----------|--------|--------|
| Framework | **Claude Agent SDK (Python)** | Direct Claude integration, OAuth support, built-in tools |
| WebSocket | FastAPI + WebSockets | Modern async Python, pairs well with Agent SDK |
| Auth | Claude Code OAuth | Uses Max subscription, no API costs |
| Storage | SQLite + JSON files | Project-local, simple, persistent |

### 3. Why Agent SDK over CLI + MCP

| Factor | CLI (`--session-id`) | Agent SDK |
|--------|---------------------|-----------|
| Latency | Process spawn (~1-2s) | In-process (minimal) |
| Streaming | Not with `-p` mode | Native async streaming |
| Hooks | External only | In-process Python functions |
| UX | No live status | Real-time "typing...", "searching..." |
| Complexity | Simpler start | Cleaner long-term |

**Decision**: Agent SDK for better UX (streaming, hooks, lower latency)

### 4. Verified: Agent SDK Works with Max Subscription

```python
# Test result:
apiKeySource: 'none'  # ← No API key needed
model: 'claude-opus-4-5-20251101'
# Successfully used Claude Code OAuth credentials
```

## Stack Summary

```
Chrome Extension:
  - TypeScript
  - Manifest V3
  - Side Panel API
  - WebSocket client

Backend Service:
  - Python 3.10+
  - Claude Agent SDK
  - FastAPI (WebSocket server)
  - SQLite (conversation history)
  - Project-local storage (.ui-chatter/)

No Additional Costs:
  - Uses Max subscription OAuth
  - No separate API charges
```

## Project Structure (Proposed)

```
ui-chatter/
├── extension/                 # Chrome extension
│   ├── manifest.json
│   ├── src/
│   │   ├── content/          # DOM extraction, click handling
│   │   ├── sidepanel/        # Chat UI
│   │   ├── background/       # WebSocket management
│   │   └── types/
│   └── package.json
│
├── service/                   # Agent SDK service
│   ├── main.py               # FastAPI + WebSocket server
│   ├── agent.py              # Claude Agent SDK integration
│   ├── storage.py            # SQLite + file management
│   └── requirements.txt
│
└── docs/
    └── tech-brainstorm/
```
