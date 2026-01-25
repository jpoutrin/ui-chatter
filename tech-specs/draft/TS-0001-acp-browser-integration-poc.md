# TS-0001: ACP Browser Integration POC

## Metadata

| Field | Value |
|-------|-------|
| **Tech Spec ID** | TS-0001 |
| **Title** | ACP Browser Integration POC |
| **Status** | COMPLETED |
| **Author** | |
| **Created** | 2026-01-15 |
| **Last Updated** | 2026-01-25 |
| **Decision Ref** | [ADR-0001: Use Agent SDK Over ACP](../../docs/decisions/ADR-0001-use-agent-sdk-over-acp.md) |
| **Related Docs** | [UI Context Bridge Brainstorm](../../docs/tech-brainstorm/2026-01-08-ui-context-bridge/session-summary.md), [POC Results](../../poc/POC-RESULTS.md) |

---

## Executive Summary

### Problem Statement

The UI Chatter project needs to validate the architecture for connecting a Chrome extension to Claude Code. Two approaches are under consideration:

1. **Agent SDK approach**: Python FastAPI service with Claude Agent SDK (in-process)
2. **ACP approach**: Node.js server using Agent Client Protocol to spawn Claude Code

This POC validates whether ACP is viable for the browser-to-agent communication pattern required by UI Chatter.

### Proposed Solution

Build a minimal end-to-end POC that:
- Chrome extension captures UI element (DOM + screenshot)
- Sends to local Node.js ACP server via WebSocket
- ACP server spawns Claude Code, forwards context
- Streams response back to extension

### Success Criteria

| Metric | Target | Actual | Result |
|--------|--------|--------|--------|
| First token latency | < 3 seconds | **~60 seconds** | ❌ FAILED |
| Streaming smoothness | No visible stuttering | Not tested | N/A |
| Memory footprint | < 200MB idle | ✅ ~50MB | ✅ PASSED |
| Process stability | No crashes in 10 interactions | ✅ Stable | ✅ PASSED |

**Outcome**: POC validated architecture but latency makes ACP non-viable for real-time chat.

### Out of Scope

- Production-ready error handling
- Multi-session support
- Screenshot storage/cleanup
- Permission inheritance from `.claude/settings.json`
- Framework DevTools integration

---

## Design Overview

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              POC Architecture                                │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────┐              ┌─────────────────────────────────────────────┐
│ Chrome Extension│              │            Node.js ACP Server               │
│                 │              │                                             │
│  ┌───────────┐  │   WebSocket  │  ┌─────────────────────────────────────┐   │
│  │ Content   │  │──────────────│─▶│  Express + ws                       │   │
│  │ Script    │  │              │  │                                     │   │
│  │           │  │              │  │  • Receives context + message       │   │
│  │ • Click   │  │              │  │  • Creates ACP provider instance    │   │
│  │   handler │  │              │  │  • Spawns Claude Code subprocess    │   │
│  │ • DOM     │  │◀─────────────│──│  • Streams response chunks          │   │
│  │   extract │  │   Streaming  │  │                                     │   │
│  └───────────┘  │   Response   │  └──────────────┬──────────────────────┘   │
│                 │              │                 │                           │
│  ┌───────────┐  │              │                 │ stdio (JSON-RPC)          │
│  │ Side      │  │              │                 ▼                           │
│  │ Panel     │  │              │  ┌─────────────────────────────────────┐   │
│  │           │  │              │  │  Claude Code (subprocess)           │   │
│  │ • Chat UI │  │              │  │                                     │   │
│  │ • Status  │  │              │  │  • Receives prompt with context     │   │
│  └───────────┘  │              │  │  • Returns streaming response       │   │
│                 │              │  │  • Full tool access (Read, Edit)    │   │
└─────────────────┘              │  └─────────────────────────────────────┘   │
                                 └─────────────────────────────────────────────┘
```

### Data Flow

```
1. User clicks element in browser
   │
   ▼
2. Content script captures:
   • Element DOM (tagName, id, classes, text, attributes)
   • Ancestor chain (3 levels)
   • Bounding box
   • Page URL + title
   │
   ▼
3. User types message in side panel: "make this blue"
   │
   ▼
4. Extension sends via WebSocket:
   {
     type: "chat",
     element: { ... },
     screenshot: "data:image/png;base64,...",
     message: "make this blue"
   }
   │
   ▼
5. ACP Server receives, builds prompt:
   "User selected this element: [DOM]
    Screenshot: [base64]
    User says: make this blue"
   │
   ▼
6. ACP Provider spawns Claude Code:
   claude --print (or via ACP protocol)
   │
   ▼
7. Claude Code processes:
   • Interprets context
   • Searches codebase (if needed)
   • Generates response
   │
   ▼
8. Response streams back through:
   Claude Code → ACP Provider → WebSocket → Extension
   │
   ▼
9. Side panel displays response in real-time
```

### Key Decision: ACP vs Agent SDK

| Aspect | ACP (This POC) | Agent SDK (Alternative) |
|--------|----------------|-------------------------|
| **Process model** | Subprocess per request | Single long-running process |
| **Startup latency** | ~1-2s (process spawn) | ~0s (in-memory) |
| **Protocol** | Open standard (JSON-RPC) | Anthropic proprietary |
| **Language** | Node.js | Python |
| **Claude Code version** | Uses installed CLI | Uses SDK (may differ) |
| **Ecosystem** | Editor-agnostic | Anthropic-specific |

**POC Goal**: Measure if subprocess spawn latency is acceptable for chat UX.

---

## Component Specifications

### 1. Chrome Extension

#### Manifest (V3)

```json
{
  "manifest_version": 3,
  "name": "UI Chatter POC",
  "version": "0.1.0",
  "permissions": [
    "activeTab",
    "sidePanel",
    "storage"
  ],
  "host_permissions": [
    "http://localhost:3456/*"
  ],
  "side_panel": {
    "default_path": "sidepanel.html"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"],
      "css": ["content.css"]
    }
  ],
  "background": {
    "service_worker": "background.js"
  },
  "action": {
    "default_title": "UI Chatter"
  }
}
```

#### Content Script Responsibilities

| Feature | Implementation |
|---------|----------------|
| Click mode toggle | Listen for message from side panel, add overlay |
| Hover highlight | CSS outline on `mouseover`, clear on `mouseout` |
| Element capture | On click: extract DOM, compute bounding box |
| Screenshot | Send element rect to background for capture |

#### DOM Extraction

```typescript
interface CapturedElement {
  tagName: string;
  id?: string;
  classList: string[];
  textContent: string;       // Truncated to 200 chars
  attributes: Record<string, string>;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

interface CapturedContext {
  element: CapturedElement;
  ancestors: Array<{
    tagName: string;
    id?: string;
    classList: string[];
  }>;  // Up to 3 levels
  page: {
    url: string;
    title: string;
  };
}
```

#### Side Panel UI

Minimal UI for POC:

```
┌─────────────────────────────────┐
│ UI Chatter POC                  │
├─────────────────────────────────┤
│ Status: 🟢 Connected            │
├─────────────────────────────────┤
│ Selected: <button class="btn">  │
│ [thumbnail]                     │
├─────────────────────────────────┤
│                                 │
│ [Chat messages area]            │
│                                 │
│ User: make this blue            │
│                                 │
│ Claude: I'll change the button  │
│ color to blue...                │
│                                 │
├─────────────────────────────────┤
│ [________________] [Send]       │
└─────────────────────────────────┘
```

### 2. Node.js ACP Server

#### Dependencies

```json
{
  "dependencies": {
    "express": "^4.18.0",
    "ws": "^8.16.0",
    "@mcpc-tech/acp-ai-provider": "latest"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "@types/node": "^20.0.0",
    "@types/ws": "^8.0.0"
  }
}
```

#### Server Structure

```
poc-server/
├── src/
│   ├── index.ts          # Entry point, Express + WebSocket setup
│   ├── acp-client.ts     # ACP provider wrapper
│   ├── prompt-builder.ts # Build prompt from UI context
│   └── types.ts          # Shared types
├── package.json
└── tsconfig.json
```

#### WebSocket Message Types

```typescript
// Extension → Server
interface ChatRequest {
  type: "chat";
  context: CapturedContext;
  screenshot?: string;      // base64 PNG (optional for POC)
  message: string;
}

// Server → Extension
interface ChatResponseChunk {
  type: "response_chunk";
  content: string;
  done: boolean;
}

interface StatusUpdate {
  type: "status";
  status: "idle" | "spawning" | "thinking" | "done" | "error";
  detail?: string;
}
```

#### ACP Integration

```typescript
import { createACPProvider } from '@mcpc-tech/acp-ai-provider';

async function handleChat(context: CapturedContext, message: string) {
  const provider = createACPProvider({
    command: 'claude',
    args: [],  // Use default Claude Code behavior
    session: {
      cwd: process.cwd(),
      mcpServers: []
    }
  });

  const prompt = buildPrompt(context, message);

  // Stream response
  const response = await provider.chat({
    messages: [{ role: 'user', content: prompt }]
  });

  for await (const chunk of response) {
    // Send chunk to WebSocket client
  }
}
```

#### Prompt Building

```typescript
function buildPrompt(context: CapturedContext, userMessage: string): string {
  const { element, ancestors, page } = context;

  return `
## UI Context

The user has selected an element on the page: ${page.url}

### Selected Element
- Tag: <${element.tagName}>
- ID: ${element.id || '(none)'}
- Classes: ${element.classList.join(', ') || '(none)'}
- Text: "${element.textContent}"
- Attributes: ${JSON.stringify(element.attributes)}

### Ancestor Chain
${ancestors.map((a, i) => `${i + 1}. <${a.tagName}> id="${a.id || ''}" class="${a.classList.join(' ')}"`).join('\n')}

## User Request

${userMessage}

## Instructions

Help the user with their request about this UI element. If they want to modify it, search the codebase to find the component and make the change.
`.trim();
}
```

---

## API Specifications

### WebSocket Endpoint

| Aspect | Value |
|--------|-------|
| URL | `ws://localhost:3456/ws` |
| Protocol | WebSocket (RFC 6455) |
| Message format | JSON |

### Message Schemas

#### Request: Chat

```json
{
  "type": "chat",
  "context": {
    "element": {
      "tagName": "button",
      "id": "submit-btn",
      "classList": ["btn", "btn-primary"],
      "textContent": "Submit",
      "attributes": { "type": "submit" },
      "boundingBox": { "x": 100, "y": 200, "width": 80, "height": 32 }
    },
    "ancestors": [
      { "tagName": "form", "id": "login-form", "classList": ["auth-form"] },
      { "tagName": "div", "id": "", "classList": ["container"] }
    ],
    "page": {
      "url": "http://localhost:5173/login",
      "title": "Login - MyApp"
    }
  },
  "message": "make this blue"
}
```

#### Response: Streaming Chunks

```json
{ "type": "response_chunk", "content": "I'll ", "done": false }
{ "type": "response_chunk", "content": "change ", "done": false }
{ "type": "response_chunk", "content": "the button color...", "done": false }
{ "type": "response_chunk", "content": "", "done": true }
```

#### Response: Status Updates

```json
{ "type": "status", "status": "spawning", "detail": "Starting Claude Code..." }
{ "type": "status", "status": "thinking", "detail": "Processing request..." }
{ "type": "status", "status": "done" }
```

---

## Security Considerations (POC Scope)

| Concern | POC Approach | Production Requirement |
|---------|--------------|------------------------|
| WebSocket origin | Accept all localhost | Validate `chrome-extension://` origin |
| File access | Unrestricted (Claude Code default) | Scope to project directory |
| Screenshot data | In-memory only | Store + auto-cleanup |
| Authentication | None | Consider API key for remote |

**Note**: Security is minimized for POC. See [security.md](../../docs/tech-brainstorm/2026-01-08-ui-context-bridge/security.md) for production requirements.

---

## Testing Plan

### Manual Test Scenarios

| # | Scenario | Steps | Expected Result |
|---|----------|-------|-----------------|
| 1 | Basic connection | Start server, open extension | Status shows "Connected" |
| 2 | Element selection | Click mode → click button | Element info appears in side panel |
| 3 | Simple chat | Select element → "describe this" | Claude describes the element |
| 4 | Code modification | Select button → "make this blue" | Claude finds and modifies component |
| 5 | Streaming | Send any message | Response appears incrementally |
| 6 | Latency measurement | Time from send to first token | Record for analysis |

### Metrics to Collect

```
┌─────────────────────────────────────────────────────────────┐
│                    Latency Breakdown                        │
├─────────────────────────────────────────────────────────────┤
│ T0: User clicks Send                                        │
│ T1: Server receives WebSocket message          (T1-T0)      │
│ T2: ACP provider starts spawning Claude Code   (T2-T1)      │
│ T3: Claude Code process ready                  (T3-T2) ←KEY │
│ T4: First response token received              (T4-T3)      │
│ T5: Response complete                          (T5-T4)      │
└─────────────────────────────────────────────────────────────┘

Target: T3-T0 < 2 seconds (spawn overhead)
        T4-T0 < 3 seconds (first token)
```

---

## Implementation Plan

### Phase 1: Server Scaffolding

- [ ] Initialize Node.js project with TypeScript
- [ ] Set up Express + WebSocket server
- [ ] Implement basic message handling (echo)
- [ ] Test WebSocket connection from browser console

### Phase 2: ACP Integration

- [ ] Install `@mcpc-tech/acp-ai-provider`
- [ ] Implement ACP provider wrapper
- [ ] Build prompt from context
- [ ] Test Claude Code spawning
- [ ] Implement streaming response relay

### Phase 3: Chrome Extension

- [ ] Create Manifest V3 extension
- [ ] Implement content script (click mode, DOM extraction)
- [ ] Implement side panel UI
- [ ] Connect to WebSocket server
- [ ] Display streaming responses

### Phase 4: Integration & Measurement

- [ ] End-to-end test: click → chat → response
- [ ] Measure latency metrics
- [ ] Document findings
- [ ] Decision: ACP vs Agent SDK

---

## File Structure (POC)

```
ui-chatter/
├── poc/
│   ├── server/                    # Node.js ACP server
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── acp-client.ts
│   │   │   ├── prompt-builder.ts
│   │   │   └── types.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── extension/                 # Chrome extension
│       ├── manifest.json
│       ├── content.ts
│       ├── content.css
│       ├── sidepanel.html
│       ├── sidepanel.ts
│       ├── background.ts
│       └── types.ts
│
├── docs/
│   └── tech-brainstorm/...
│
└── tech-specs/
    └── draft/
        └── TS-0001-acp-browser-integration-poc.md
```

---

## Decision Criteria

After POC completion, evaluate:

| Criterion | Weight | ACP Score | Agent SDK Score |
|-----------|--------|-----------|-----------------|
| First token latency | 30% | TBD | ~0.5s (estimated) |
| Streaming quality | 20% | TBD | Native |
| Code complexity | 15% | TBD | Moderate |
| Future ecosystem | 20% | Open standard | Vendor lock-in |
| Maintenance burden | 15% | TBD | TBD |

**Recommendation threshold**: If ACP latency < 3s, prefer ACP for ecosystem benefits. If > 3s, prefer Agent SDK for UX.

---

## Open Questions

1. **Does `@mcpc-tech/acp-ai-provider` support streaming?** - Need to verify in POC
2. **Can we pass screenshot to Claude Code via ACP?** - May need file path workaround
3. **Does Claude Code respect CWD when spawned via ACP?** - Critical for file operations
4. **What happens if Claude Code is already running?** - Concurrent process behavior

---

## Appendix

### References

- [Agent Client Protocol Spec](https://agentclientprotocol.com/)
- [ACP GitHub](https://github.com/agentclientprotocol/agent-client-protocol)
- [ACP AI SDK Provider](https://ai-sdk.dev/providers/community-providers/acp)
- [UI Context Bridge Brainstorm](../../docs/tech-brainstorm/2026-01-08-ui-context-bridge/session-summary.md)

### Glossary

| Term | Definition |
|------|------------|
| ACP | Agent Client Protocol - open standard for editor ↔ AI agent communication |
| Agent SDK | Claude Agent SDK - Anthropic's Python SDK for building agents |
| MCP | Model Context Protocol - Anthropic's tool/resource protocol |
| Side Panel | Chrome extension UI that appears alongside the webpage |

---

## POC Completion Summary

**Date Completed**: 2026-01-25

### Results

The POC was **successfully completed** and fully functional. All components worked as designed:

✅ **Chrome Extension** - Click mode, DOM capture, side panel UI, WebSocket client
✅ **Node.js Server** - WebSocket server, subprocess management, streaming
✅ **End-to-End Flow** - Element selection → chat → response

However, latency measurements revealed a critical issue:

❌ **First token latency: ~60 seconds** (vs <3s target)

### Decision

Based on POC data, **Agent SDK approach selected** over ACP. See [ADR-0001](../../docs/decisions/ADR-0001-use-agent-sdk-over-acp.md) for full rationale.

### Artifacts

- **POC Code**: Preserved in `poc/` directory
- **Results**: [POC-RESULTS.md](../../poc/POC-RESULTS.md)
- **Decision**: [ADR-0001](../../docs/decisions/ADR-0001-use-agent-sdk-over-acp.md)

### Key Learnings

1. Subprocess spawn overhead is significant (~60s for Claude Code initialization)
2. In-process agent (Agent SDK) eliminates this overhead
3. WebSocket + side panel architecture is solid and reusable
4. Chrome extension patterns validated for production use

### Next Steps

Proceed with Agent SDK implementation using learnings from this POC.
