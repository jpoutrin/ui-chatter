# TS-0002: Agent SDK MVP Implementation

## Metadata

| Field | Value |
|-------|-------|
| **Tech Spec ID** | TS-0002 |
| **Title** | Agent SDK MVP Implementation |
| **Status** | DRAFT |
| **Author** | |
| **Created** | 2026-01-25 |
| **Last Updated** | 2026-01-25 |
| **Decision Ref** | [ADR-0001: Use Agent SDK Over ACP](../../docs/decisions/ADR-0001-use-agent-sdk-over-acp.md) |
| **Related Docs** | [POC Results](../../poc/POC-RESULTS.md), [TS-0001: ACP POC](./TS-0001-acp-browser-integration-poc.md), [UI Context Bridge Brainstorm](../../docs/tech-brainstorm/2026-01-08-ui-context-bridge/session-summary.md) |

---

## Executive Summary

### Problem Statement

Following the ACP POC (TS-0001), we've validated the browser-to-agent architecture but identified that subprocess spawn latency (~60s) makes ACP non-viable for real-time chat. We need to implement the production-ready system using Claude Agent SDK for acceptable latency (<1s).

### Proposed Solution

Build a Python FastAPI service with Claude Agent SDK that:
- Reuses the validated Chrome extension from POC
- Maintains the WebSocket protocol (proven to work)
- Provides in-process agent execution for <1s latency
- Supports project-local storage and settings inheritance
- Enables screenshot capture and hot-reload workflows

### Success Criteria

| Metric | Target | Rationale |
|--------|--------|-----------|
| First token latency | < 1 second | Real-time chat UX (100x better than ACP) |
| Chrome extension reuse | 100% code reuse | Validated in POC, no rework needed |
| Memory footprint | < 500MB | Reasonable for long-running Python service |
| Settings inheritance | Full `.claude/settings.json` support | Security and permission consistency |
| Multi-tab support | Isolated sessions | Professional dev tool requirement |

---

## Design Overview

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Agent SDK MVP Architecture                            │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────┐              ┌─────────────────────────────────────────────┐
│ Chrome Extension│              │         Python FastAPI Service              │
│  (from POC)     │              │                                             │
│                 │              │  ┌─────────────────────────────────────┐   │
│  ┌───────────┐  │   WebSocket  │  │  FastAPI + WebSocket Server         │   │
│  │ Content   │  │──────────────│─▶│                                     │   │
│  │ Script    │  │              │  │  • Receives context + message       │   │
│  │           │  │              │  │  • Manages Claude Agent instances  │   │
│  │ • Click   │  │              │  │  • Streams responses               │   │
│  │   mode    │  │              │  │  • Screenshot storage              │   │
│  │ • DOM     │  │◀─────────────│──│                                     │   │
│  │   extract │  │   Streaming  │  └──────────────┬──────────────────────┘   │
│  └───────────┘  │   Response   │                 │                           │
│                 │              │                 │ In-process                │
│  ┌───────────┐  │              │                 ▼                           │
│  │ Side      │  │              │  ┌─────────────────────────────────────┐   │
│  │ Panel     │  │              │  │  Claude Agent SDK                   │   │
│  │           │  │              │  │                                     │   │
│  │ • Chat UI │  │              │  │  • In-memory agent                 │   │
│  │ • Status  │  │              │  │  • Full tool access                │   │
│  └───────────┘  │              │  │  • Project settings inheritance    │   │
└─────────────────┘              │  └─────────────────────────────────────┘   │
                                 │                                             │
                                 │  ┌─────────────────────────────────────┐   │
                                 │  │  Project Storage                    │   │
                                 │  │                                     │   │
                                 │  │  .ui-chatter/                       │   │
                                 │  │  ├── sessions/                      │   │
                                 │  │  ├── screenshots/                   │   │
                                 │  │  └── history.db                     │   │
                                 │  └─────────────────────────────────────┘   │
                                 └─────────────────────────────────────────────┘
```

### Data Flow

Same as POC, but with Agent SDK:

```
1. User clicks element in browser
   ↓
2. Content script captures DOM + bounding box
   ↓
3. User types message: "make this blue"
   ↓
4. Extension sends via WebSocket:
   {
     type: "chat",
     element: {...},
     screenshot: "base64...",
     message: "make this blue"
   }
   ↓
5. FastAPI receives, builds prompt
   ↓
6. Agent SDK processes (IN-PROCESS):
   • Interprets context
   • Searches codebase
   • Generates response
   ↓
7. Response streams back:
   Agent SDK → FastAPI → WebSocket → Extension
   ↓
8. Side panel displays response in real-time
```

---

## Component Specifications

### 1. Chrome Extension (Reuse from POC)

**Status**: ✅ Already complete, no changes needed

The extension from POC will work as-is because:
- WebSocket protocol remains identical
- Message format unchanged
- DOM extraction logic validated

**Minor Enhancements** (optional, post-MVP):
- Screenshot cropping (not needed for latency test)
- Multiple element selection
- Session persistence UI

### 2. Python FastAPI Service

#### Dependencies

```toml
[tool.poetry.dependencies]
python = "^3.10"
fastapi = "^0.109.0"
uvicorn = {extras = ["standard"], version = "^0.27.0"}
websockets = "^12.0"
claude-agent-sdk = "^0.2.0"  # Anthropic's official SDK
pydantic = "^2.6.0"
python-dotenv = "^1.0.0"
```

#### Project Structure

```
service/
├── pyproject.toml
├── poetry.lock
├── .env.example
├── README.md
└── src/
    ├── __init__.py
    ├── main.py              # FastAPI app + WebSocket server
    ├── agent_manager.py     # Agent SDK wrapper
    ├── prompt_builder.py    # Build prompts from UI context
    ├── screenshot_store.py  # Screenshot storage + cleanup
    ├── session_manager.py   # Multi-session support
    ├── config.py            # Settings loader
    └── models/
        ├── __init__.py
        ├── messages.py      # WebSocket message types
        └── context.py       # UI context models
```

#### WebSocket Message Types

Reuse from POC (validated protocol):

```python
# Extension → Server
class ChatRequest(BaseModel):
    type: Literal["chat"]
    context: CapturedContext
    screenshot: Optional[str]  # base64 PNG
    message: str

# Server → Extension
class ResponseChunk(BaseModel):
    type: Literal["response_chunk"]
    content: str
    done: bool

class StatusUpdate(BaseModel):
    type: Literal["status"]
    status: Literal["idle", "thinking", "done", "error"]
    detail: Optional[str]
```

#### Agent SDK Integration

```python
from claude_agent_sdk import ClaudeAgent, ClaudeAgentOptions

class AgentManager:
    def __init__(self, project_path: str):
        self.project_path = project_path
        self.agent = self._create_agent()

    def _create_agent(self) -> ClaudeAgent:
        options = ClaudeAgentOptions(
            cwd=self.project_path,
            setting_sources=["project"],  # Load .claude/settings.json
        )
        return ClaudeAgent(options)

    async def handle_chat(
        self,
        context: CapturedContext,
        message: str,
        screenshot_path: Optional[str] = None
    ) -> AsyncGenerator[str, None]:
        """
        Stream response from Agent SDK.

        Latency: ~0.5s first token (vs 60s with ACP)
        """
        prompt = build_prompt(context, message, screenshot_path)

        async for chunk in self.agent.chat(prompt):
            yield chunk
```

#### Screenshot Storage

```python
from pathlib import Path
import base64
from datetime import datetime, timedelta

class ScreenshotStore:
    def __init__(self, project_path: str):
        self.screenshots_dir = Path(project_path) / ".ui-chatter" / "screenshots"
        self.screenshots_dir.mkdir(parents=True, exist_ok=True)

    def save(self, session_id: str, context_id: str, base64_data: str) -> str:
        """Save screenshot and return file path."""
        filename = f"{session_id}_{context_id}.png"
        filepath = self.screenshots_dir / filename

        # Decode and save
        image_data = base64.b64decode(base64_data.split(",")[1])
        filepath.write_bytes(image_data)

        return str(filepath)

    def cleanup_old(self, max_age_hours: int = 24):
        """Delete screenshots older than max_age_hours."""
        cutoff = datetime.now() - timedelta(hours=max_age_hours)

        for screenshot in self.screenshots_dir.glob("*.png"):
            if datetime.fromtimestamp(screenshot.stat().st_mtime) < cutoff:
                screenshot.unlink()
```

#### Settings Inheritance

```python
from pathlib import Path
import json

class ProjectConfig:
    def __init__(self, project_path: str):
        self.project_path = Path(project_path)
        self.settings = self._load_settings()

    def _load_settings(self) -> dict:
        """Load .claude/settings.json if exists."""
        settings_file = self.project_path / ".claude" / "settings.json"

        if not settings_file.exists():
            return {}

        return json.loads(settings_file.read_text())

    @property
    def allowed_tools(self) -> list[str]:
        return self.settings.get("allowedTools", [])

    @property
    def disallowed_tools(self) -> list[str]:
        return self.settings.get("disallowedTools", [])
```

### 3. CLI Interface

```bash
# Start server
ui-chatter serve [OPTIONS]

Options:
  --project PATH    Project directory (default: current)
  --port INT        WebSocket port (default: 3456)
  --host STR        Bind address (default: localhost)
  --debug           Enable debug logging
  --help            Show help message
```

Implementation:

```python
import click
import uvicorn
from pathlib import Path

@click.command()
@click.option("--project", default=".", help="Project directory")
@click.option("--port", default=3456, help="WebSocket port")
@click.option("--host", default="localhost", help="Bind address")
@click.option("--debug", is_flag=True, help="Enable debug logging")
def serve(project: str, port: int, host: str, debug: bool):
    """Start UI Chatter service."""
    project_path = Path(project).resolve()

    if not project_path.exists():
        click.echo(f"Error: Project directory not found: {project_path}")
        return

    # Auto-add .ui-chatter/ to .gitignore
    gitignore = project_path / ".gitignore"
    if gitignore.exists() and ".ui-chatter/" not in gitignore.read_text():
        with gitignore.open("a") as f:
            f.write("\n# UI Chatter\n.ui-chatter/\n")

    click.echo(f"🚀 Starting UI Chatter service...")
    click.echo(f"📁 Project: {project_path}")
    click.echo(f"📡 WebSocket: ws://{host}:{port}")

    uvicorn.run(
        "ui_chatter.main:app",
        host=host,
        port=port,
        log_level="debug" if debug else "info",
        reload=debug
    )
```

---

## API Specifications

### WebSocket Endpoint

Same as POC (validated protocol):

| Aspect | Value |
|--------|-------|
| URL | `ws://localhost:3456/ws` |
| Protocol | WebSocket (RFC 6455) |
| Message format | JSON |
| Reconnection | Client handles with exponential backoff |

### Message Schemas

Reuse from POC - already validated in end-to-end testing.

---

## Security Considerations

| Concern | Implementation | Status |
|---------|----------------|--------|
| **WebSocket origin** | Validate `chrome-extension://` origin | Required |
| **File access** | Scoped to project via Agent SDK options | Required |
| **Settings inheritance** | Use Agent SDK's built-in settings loader | Required |
| **Screenshot cleanup** | Auto-delete > 24 hours | Required |
| **Tool permissions** | Inherit from `.claude/settings.json` | Required |

---

## Testing Plan

### Unit Tests

```python
# tests/test_prompt_builder.py
def test_builds_prompt_from_context():
    context = CapturedContext(...)
    prompt = build_prompt(context, "make this blue")

    assert "make this blue" in prompt
    assert "<button>" in prompt
    assert context.element.id in prompt

# tests/test_screenshot_store.py
def test_saves_and_retrieves_screenshot():
    store = ScreenshotStore("/tmp/test-project")
    path = store.save("session1", "ctx1", "data:image/png;base64,...")

    assert Path(path).exists()
    assert Path(path).suffix == ".png"
```

### Integration Tests

```python
# tests/test_integration.py
async def test_end_to_end_chat():
    # Start service
    service = await start_service()

    # Connect WebSocket
    async with websockets.connect("ws://localhost:3456/ws") as ws:
        # Send chat request
        await ws.send(json.dumps({
            "type": "chat",
            "context": {...},
            "message": "describe this element"
        }))

        # Receive response chunks
        chunks = []
        async for message in ws:
            data = json.loads(message)
            if data["type"] == "response_chunk":
                chunks.append(data["content"])
                if data["done"]:
                    break

        response = "".join(chunks)
        assert len(response) > 0
```

### Manual Test Scenarios

| # | Scenario | Expected Result |
|---|----------|-----------------|
| 1 | Start service → connect extension | Status shows "Connected" ✅ |
| 2 | Click element → send message | Response in <2s total ⚡ |
| 3 | Multi-turn conversation | History maintained ✅ |
| 4 | Screenshot capture | Saved to `.ui-chatter/screenshots/` ✅ |
| 5 | Code modification → hot reload | Vite reloads automatically ✅ |

---

## Implementation Plan

### Phase 1: Service Core (Week 1, Days 1-3)

- [x] Scaffold Python project with Poetry
- [ ] Implement FastAPI + WebSocket server
- [ ] Integrate Agent SDK (basic chat)
- [ ] Test with POC Chrome extension
- [ ] Verify <1s latency ⚡

### Phase 2: Features (Week 1, Days 4-5)

- [ ] Screenshot storage + cleanup
- [ ] Session management (multi-tab)
- [ ] Settings inheritance from `.claude/settings.json`
- [ ] Project-local storage (`.ui-chatter/`)

### Phase 3: Polish (Week 2)

- [ ] CLI: `ui-chatter serve`
- [ ] Error handling + logging
- [ ] Auto-gitignore `.ui-chatter/`
- [ ] Documentation (README, setup guide)

### Phase 4: Testing (Week 2-3)

- [ ] Unit tests (>80% coverage)
- [ ] Integration tests
- [ ] Manual testing on real projects
- [ ] Performance benchmarks

---

## Success Metrics

| Metric | Target | How to Measure |
|--------|--------|----------------|
| **Latency** | <1s first token | Server logs + timer |
| **Memory** | <500MB idle | `ps aux \| grep python` |
| **Extension reuse** | 100% | No code changes needed |
| **Settings** | Full inheritance | Test with various `.claude/settings.json` |
| **Reliability** | No crashes in 100 chats | Stress testing |

---

## Risks and Mitigation

| Risk | Mitigation |
|------|-----------|
| Agent SDK API changes | Pin SDK version, monitor releases |
| Memory leaks | Implement session cleanup, monitor memory |
| WebSocket disconnects | Client auto-reconnect (already in POC) |
| Screenshot disk usage | Auto-cleanup, configurable retention |
| OAuth expiration | Agent SDK handles refresh automatically |

---

## Open Questions

1. **Multi-project support** - One service instance per project, or global service?
   - **Recommendation**: One per project (simpler, isolated)

2. **Conversation history** - SQLite local, or agent-managed?
   - **Recommendation**: Agent SDK manages (already built-in)

3. **Screenshot optimization** - Store full or crop to element?
   - **Recommendation**: Start with full, optimize later

4. **Hot reload detection** - Active monitoring or passive?
   - **Recommendation**: Passive (frameworks already handle this)

---

## Appendix

### POC Learnings

From TS-0001, we learned:

✅ **Keep**:
- Chrome extension architecture
- WebSocket protocol
- DOM extraction logic
- Side panel UI

🔄 **Change**:
- Subprocess → In-process (Agent SDK)
- Node.js → Python (better SDK support)
- Custom spawning → SDK-managed agent

### References

- [Agent SDK Documentation](https://github.com/anthropics/anthropic-sdk-python)
- [POC Results](../../poc/POC-RESULTS.md)
- [ADR-0001](../../docs/decisions/ADR-0001-use-agent-sdk-over-acp.md)
- [Integration Points](../../docs/tech-brainstorm/2026-01-08-ui-context-bridge/integration-points.md)
