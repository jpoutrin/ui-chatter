# Brainstorming Summary: UI Context Bridge for AI Coding Tools

**Project Name**: UI Chatter
**Date**: 2026-01-08

---

## Problem Statement

It's hard to interact with Claude Code (or similar AI coding tools) about UI components. Describing "that button in the top-right" is imprecise and leads to back-and-forth clarification.

## Solution

A Chrome extension + local service that lets you **point and click** on UI elements, providing Claude with **narrow, precise context** to make accurate code changes.

---

## Architecture

```
┌─────────────────┐              ┌─────────────────────────────────────┐
│ Chrome Extension│──WebSocket──▶│       Agent SDK Service             │
│                 │◀─────────────│                                     │
│  • Click mode   │   streaming  │  • FastAPI (WebSocket server)       │
│  • Side panel   │   responses  │  • Claude Agent SDK (Python)        │
│  • DOM capture  │              │  • Uses Max subscription OAuth      │
│  • Screenshot   │              │  • Built-in tools (Read, Edit, etc) │
└─────────────────┘              └─────────────────────────────────────┘
```

---

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Backend** | Claude Agent SDK (Python) | Single process, streaming, hooks, uses Max OAuth |
| **Communication** | WebSocket | Bidirectional, real-time status + responses |
| **Auth** | Claude Code OAuth | Verified: works with Max subscription, no API costs |
| **Storage** | Project-local `.ui-chatter/` | SQLite history + screenshot files |
| **Permissions** | Inherit from `.claude/settings.json` | Consistent with existing Claude Code setup |
| **Component detection** | DOM analysis + fuzzy matching | Framework DevTools = future enhancement |

---

## Core Value Proposition

**Narrow context** through point-and-click:

| Without UI Chatter | With UI Chatter |
|--------------------|-----------------|
| "Change the submit button color" | *click* + "make this blue" |
| Claude searches, asks clarifications | Claude sees exact element + screenshot |
| Wide context, slow | Narrow context, fast |

---

## MVP Feature Set

### Chrome Extension
- [ ] Click mode with hover highlight
- [ ] Side panel chat UI
- [ ] DOM extraction (element + ancestors)
- [ ] Screenshot capture (Chrome API + crop)
- [ ] WebSocket connection to local service

### Agent SDK Service
- [ ] FastAPI WebSocket server
- [ ] Claude Agent SDK integration
- [ ] Screenshot storage + cleanup (24h TTL)
- [ ] Session management (multi-tab support)
- [ ] Streaming responses to extension
- [ ] Inherit project Claude Code settings

### CLI
- [ ] `ui-chatter serve` - start service in project directory
- [ ] `--port` option for custom port
- [ ] `--project` option for explicit path

---

## Data Flow

```
1. User clicks element in browser
2. Extension captures: DOM + screenshot + bounding box
3. User types message in side panel: "make this blue"
4. Extension sends via WebSocket: { element, screenshot (base64), message }
5. Service saves screenshot to .ui-chatter/screenshots/
6. Service builds prompt with narrow context
7. Claude Agent SDK processes:
   - Reads screenshot (multimodal)
   - Searches codebase for component
   - Edits file
8. Service streams response back to extension
9. Extension displays in chat
10. Vite/Webpack hot-reloads changes
```

---

## Security Model

| Concern | Mitigation |
|---------|------------|
| File access scope | Project directory only, blocked outside |
| Tool permissions | Inherit from `.claude/settings.json` |
| WebSocket origin | Validate `chrome-extension://` origin |
| Screenshots | Local only, auto-delete after 24h, gitignored |

---

## Project Structure

```
ui-chatter/
├── extension/                 # Chrome extension (TypeScript)
│   ├── manifest.json         # Manifest V3
│   ├── src/
│   │   ├── content/          # DOM extraction, click handling
│   │   ├── sidepanel/        # Chat UI (React or vanilla)
│   │   └── background/       # WebSocket, screenshot capture
│   └── package.json
│
├── service/                   # Agent SDK service (Python)
│   ├── main.py               # FastAPI + WebSocket
│   ├── agent.py              # Claude Agent SDK integration
│   ├── storage.py            # SQLite + screenshots
│   ├── security.py           # Hooks for permission enforcement
│   └── requirements.txt
│
└── docs/
    └── tech-brainstorm/
        └── 2026-01-08-ui-context-bridge/
            ├── system-components.md
            ├── api-design.md
            ├── tech-choices.md
            ├── security.md
            ├── integration-points.md
            └── session-summary.md   # This file
```

---

## Verified

- ✅ Claude Agent SDK works with Max subscription OAuth (no API key needed)
- ✅ Agent SDK has access to Read, Edit, Glob, Grep, Bash tools
- ✅ Screenshots can be read by Claude (multimodal via Read tool)

---

## Future Enhancements

| Enhancement | Benefit |
|-------------|---------|
| React/Vue DevTools integration | Direct component → file mapping |
| Native messaging auto-start | Extension launches service automatically |
| Multi-project support | Central registry of active projects |
| Conversation export | Save chat history as markdown |

---

## Next Steps

1. **Scaffold extension** - Manifest V3, side panel, content script
2. **Scaffold service** - FastAPI + Agent SDK minimal setup
3. **Implement click-to-capture** - DOM + screenshot extraction
4. **Implement WebSocket** - Bidirectional communication
5. **Implement agent loop** - Prompt building, streaming responses
6. **Test end-to-end** - Click element → chat → code change → hot reload

---

## Files Created

```
docs/tech-brainstorm/2026-01-08-ui-context-bridge/
├── system-components.md
├── api-design.md
├── tech-choices.md
├── security.md
├── integration-points.md
└── session-summary.md
```
