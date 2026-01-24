# Integration Points

## Overview

```
┌─────────────────┐              ┌─────────────────────────────────────┐
│ Chrome Extension│──WebSocket──▶│       Agent SDK Service             │
│                 │◀─────────────│                                     │
│  • Click mode   │              │  • FastAPI + WebSocket              │
│  • Side panel   │              │  • Claude Agent SDK                 │
│  • Screenshot   │              │  • Project storage                  │
│    capture      │              │  • Settings inheritance             │
└─────────────────┘              └─────────────────────────────────────┘
        │                                       │
        ▼                                       ▼
   Chrome APIs                           Project Files
   • captureVisibleTab                   • .ui-chatter/
   • sidePanel                           • .claude/settings.json
   • storage                             • Source code
```

---

## 1. Extension ↔ Service (WebSocket)

| Aspect | Details |
|--------|---------|
| Protocol | WebSocket |
| Endpoint | `ws://localhost:3456/ws` |
| Port | Configurable, default `3456` |
| Reconnection | Auto-reconnect with exponential backoff |

### Connection States

```
Extension UI states:
• 🔴 "Not connected" - Service not running
• 🟡 "Connecting..." - WebSocket connecting
• 🟢 "Connected" - Ready to use
```

---

## 2. Screenshot Handling

### Capture (Extension)

```typescript
// Chrome API capture + crop
const rect = element.getBoundingClientRect();
const fullTab = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
const cropped = await cropImage(fullTab, rect);  // base64 PNG
```

### Transmission

- Format: Base64 PNG inline in WebSocket message
- Size: Typically 100KB-500KB per screenshot

### Storage (Service)

```
.ui-chatter/screenshots/
├── {sessionId}_{contextId}.png
└── ...
```

### Claude Reads It

```python
prompt = f"""
Screenshot: Read the image at {screenshot_path}
"""
# Claude calls Read tool → sees the image (multimodal)
```

### Cleanup

- Auto-delete screenshots older than 24 hours
- Run cleanup on service startup and periodically

---

## 3. Service ↔ Claude Code OAuth

| Aspect | Details |
|--------|---------|
| Auth source | `~/.claude/.credentials.json` |
| Handling | Automatic via Agent SDK |
| Token refresh | Managed by SDK |
| Subscription | Works with Max plan |

**Verified**: Agent SDK uses Claude Code OAuth without API key.

---

## 4. Service ↔ Project Settings

```python
options = ClaudeAgentOptions(
    cwd=project_path,
    setting_sources=["project"],  # Loads .claude/settings.json
)
```

Inherits:
- `allowedTools` / `disallowedTools`
- `permissions.allow` / `permissions.deny`
- Any project-specific hooks

---

## 5. Service ↔ Project Storage

### Directory Structure

```
{project}/
├── .ui-chatter/
│   ├── sessions/
│   │   └── {sessionId}.json      # Current context per session
│   ├── screenshots/
│   │   └── {sessionId}_{contextId}.png
│   └── history.db                # SQLite conversation history
├── .claude/
│   └── settings.json             # Claude Code project settings
└── src/
    └── ...                       # Project source code
```

### Auto-gitignore

```python
# On first init, add to .gitignore
.ui-chatter/
```

---

## 6. Service Startup

### MVP: Manual Start

```bash
# Start in project directory
cd my-project
ui-chatter serve

# Or specify project path
ui-chatter serve --project /path/to/project --port 3456
```

### Future: Auto-start Options

| Method | How |
|--------|-----|
| Native messaging | Extension launches service via Chrome native messaging |
| Launchd/systemd | Background daemon, always running |
| VS Code task | Start with dev server |

---

## 7. Hot Reload (Automatic)

No integration needed. When Agent SDK edits a file:
1. Vite/Webpack/Next.js watches file system
2. Detects change automatically
3. Hot reloads the browser

User sees changes immediately after Claude edits.

---

## Integration Checklist

| Integration | MVP | Status |
|-------------|-----|--------|
| Extension ↔ Service WebSocket | ✅ | Required |
| Screenshot capture + storage | ✅ | Required |
| Service ↔ Claude OAuth | ✅ | Verified |
| Service ↔ Project settings | ✅ | Required |
| Project-local storage | ✅ | Required |
| Manual service startup | ✅ | Required |
| Auto-gitignore | ✅ | Required |
| Framework DevTools | ❌ | Future |
| Native messaging auto-start | ❌ | Future |
