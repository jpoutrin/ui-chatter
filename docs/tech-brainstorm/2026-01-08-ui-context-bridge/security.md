# Security Considerations

## Trust Model

```
┌─────────────────────────────────────────────────────────────────┐
│                       LOCAL ONLY                                │
│                                                                 │
│   Browser Tab          Extension           Agent SDK Service    │
│   (untrusted)          (trusted)           (trusted)            │
│       │                    │                    │               │
│       │   DOM click        │    WebSocket       │               │
│       └───────────────────▶│───────────────────▶│               │
│                            │   localhost:PORT   │               │
│                            │                    │               │
│                            │◀───────────────────│               │
│                            │    responses       │               │
└─────────────────────────────────────────────────────────────────┘
```

## Key Security Decisions

### 1. Inherit Project Claude Code Settings

The service should respect the project's existing `.claude/settings.json`:

```python
from claude_agent_sdk import query, ClaudeAgentOptions

options = ClaudeAgentOptions(
    cwd=project_path,
    setting_sources=["project"],  # Load project settings
    # Tools, permissions, allowed commands come from project config
)
```

This means:
- If project allows `Bash`, service allows `Bash`
- If project has `allowedTools` restrictions, service respects them
- If project has hook configurations, they apply

### 2. Edit Approval Scope

| Location | Approval Required |
|----------|-------------------|
| Project files (`cwd/*`) | Per project settings |
| Outside project | **Always blocked** |
| System files | **Always blocked** |

```python
# Enforce project-only file access
async def enforce_project_scope(input_data, tool_use_id, context):
    tool = input_data["tool_name"]
    if tool in ["Edit", "Write", "Read"]:
        file_path = input_data["tool_input"].get("file_path", "")
        if not file_path.startswith(PROJECT_ROOT):
            return {
                "hookSpecificOutput": {
                    "permissionDecision": "deny",
                    "permissionDecisionReason": f"Access outside project blocked: {file_path}"
                }
            }
    return {}
```

### 3. Bash Follows Project Settings

```yaml
# .claude/settings.json (example)
{
  "permissions": {
    "allow": ["Bash(npm:*)", "Bash(git:*)"],
    "deny": ["Bash(rm -rf *)"]
  }
}
```

Service inherits these rules automatically via `setting_sources=["project"]`.

---

## Attack Vectors & Mitigations

### 1. DOM Injection Attack

**Risk**: Malicious webpage injects harmful instructions in DOM.

**Mitigation**:
- Only capture user-clicked elements (explicit action)
- Claude's safety training filters harmful requests
- User reviews instruction in chat before sending

### 2. WebSocket Hijacking

**Risk**: Other local process connects to service.

**Mitigation**:
```python
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    origin = websocket.headers.get("origin", "")
    # Only accept connections from Chrome extension
    if not origin.startswith("chrome-extension://"):
        await websocket.close(code=4003, reason="Invalid origin")
        return
    await websocket.accept()
```

### 3. Path Traversal

**Risk**: Agent tries to access `/etc/passwd` or `~/.ssh/`.

**Mitigation**:
```python
import os

def is_within_project(file_path: str, project_root: str) -> bool:
    """Prevent path traversal attacks."""
    abs_path = os.path.abspath(file_path)
    abs_root = os.path.abspath(project_root)
    return abs_path.startswith(abs_root + os.sep)
```

### 4. Screenshot Data Leakage

**Risk**: Screenshots contain sensitive visible data.

**Mitigation**:
- Store in `.ui-chatter/screenshots/` (project-local)
- Auto-delete after 24 hours
- Add `.ui-chatter/` to `.gitignore`
- Never transmit outside localhost

---

## Security Configuration

```python
# service/security.py

from claude_agent_sdk import ClaudeAgentOptions, HookMatcher

def get_secure_options(project_path: str) -> ClaudeAgentOptions:
    return ClaudeAgentOptions(
        cwd=project_path,
        setting_sources=["project"],  # Inherit project permissions
        hooks={
            "PreToolUse": [
                HookMatcher(
                    matcher="Edit|Write|Read",
                    hooks=[enforce_project_scope]
                ),
                HookMatcher(
                    matcher=".*",
                    hooks=[audit_log]  # Log all tool usage
                ),
            ]
        }
    )

async def audit_log(input_data, tool_use_id, context):
    """Log all tool invocations for debugging/security."""
    tool = input_data["tool_name"]
    # Log to .ui-chatter/audit.log
    return {}

async def enforce_project_scope(input_data, tool_use_id, context):
    """Block file access outside project directory."""
    # Implementation above
    pass
```

---

## Checklist

- [x] Inherit tool permissions from project `.claude/settings.json`
- [x] Restrict file operations to project directory
- [x] Validate WebSocket origin (Chrome extension only)
- [x] Auto-cleanup screenshots (TTL)
- [x] Audit logging for tool usage
- [ ] Optional: Domain allowlist for extension
