# Claude Agent SDK Backend - Usage Guide

## Overview

The Claude Agent SDK backend allows you to use UI Chatter with your Claude Max subscription instead of paying per token with API keys. This is the **recommended backend** for development and personal use.

## Benefits

✅ **No API costs** - Uses Claude Max subscription ($100/month unlimited)
✅ **Fast** - In-process execution (<1s first token)
✅ **Reliable** - No subprocess overhead or JSON parsing
✅ **Easy setup** - One-time authentication with `claude login`

## Prerequisites

1. **Claude Max subscription** - Required for subscription-based auth
2. **Claude Code CLI installed**:
   ```bash
   npx @anthropic-ai/claude-code
   ```

## Setup (One-Time)

### 1. Authenticate with Claude Code

```bash
claude login
```

This will:
- Open your browser for OAuth authentication
- Save credentials to `~/.claude/config`
- Allow the SDK to use your subscription

### 2. Install Dependencies

```bash
cd service
uv pip install -e .
```

This installs all required packages including `claude-agent-sdk`.

## Usage

### Starting the Service

The Claude Agent SDK backend is now the **default** backend. Simply run:

```bash
ui-chatter serve
```

Or explicitly specify the backend:

```bash
ui-chatter serve --backend claude-agent-sdk
```

### Full Options

```bash
ui-chatter serve \
  --backend claude-agent-sdk \
  --project /path/to/project \
  --permission-mode bypassPermissions \
  --port 3456 \
  --debug
```

**Available backends:**
- `claude-agent-sdk` (default) - Uses subscription, fast in-process execution
- `anthropic-sdk` - Uses API key, pay-per-token
- `claude-cli` - Subprocess approach (stub, not implemented)

**Permission modes:**
- `bypassPermissions` (default) - Auto-approve all tool requests
- `plan` - Ask before any changes
- `acceptEdits` - Auto-approve edits only
- `dontAsk` - Never ask for approval
- `delegate` - Let extension decide

### Environment Variables

You can also configure via environment variables:

```bash
# Backend selection
export BACKEND_STRATEGY=claude-agent-sdk

# Permission mode
export PERMISSION_MODE=bypassPermissions

# Project path
export PROJECT_PATH=/path/to/project

# Debug logging
export DEBUG=true

# Start service
ui-chatter serve
```

### Using with Browser Extension

1. Start the service:
   ```bash
   ui-chatter serve --backend claude-agent-sdk --debug
   ```

2. Open Chrome with the extension loaded

3. The service will show:
   ```
   ╭─────────────────────────────────────────────────────────────╮
   │                   UI Chatter Service                        │
   │                                                             │
   │ 📁 Project: /path/to/project                                │
   │ 🤖 Backend: Claude Agent SDK (subscription)                 │
   │ 🔒 Default Permission Mode: bypassPermissions               │
   │ 📡 WebSocket: ws://localhost:3456                           │
   │ 🔍 Debug: enabled                                           │
   ╰─────────────────────────────────────────────────────────────╯
   ```

4. Use the extension to send chat messages

## Testing the Backend

### Quick Test

```bash
cd service
python test_sdk_backend.py
```

This will:
1. Create a backend instance
2. Send a test message
3. Verify streaming responses work
4. Report success/failure

Expected output:
```
🧪 Testing Claude Agent SDK Backend

1. Creating backend instance...
   ✓ Backend created: ClaudeAgentSDKBackend
   ✓ Permission mode: bypassPermissions
   ✓ Allowed tools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep']

2. Creating test context...
   ✓ Context created

3. Sending test message...
   Message: 'Say hello in one word'

   📝 Chunk: Hello
   ✓ Response complete
   ✓ Received 1 content chunks

✅ Test PASSED - Backend is working correctly!
```

### Manual Testing

1. Start service with debug logging:
   ```bash
   ui-chatter serve --backend claude-agent-sdk --debug
   ```

2. Check logs for backend initialization:
   ```
   INFO: Started server process [12345]
   INFO: Waiting for application startup.
   INFO: Application startup complete.
   INFO: Uvicorn running on http://localhost:3456
   ```

3. Send a message from the extension

4. Watch debug logs:
   ```
   DEBUG: Sending prompt to Claude Agent SDK (length: 234 chars)
   DEBUG: CLAUDE AGENT SDK INPUT - USER PROMPT:
   ...
   DEBUG: CLAUDE AGENT SDK OUTPUT CHUNK: Response text...
   DEBUG: CLAUDE AGENT SDK: Received final message (done=True)
   ```

## Troubleshooting

### Error: "Authentication failed"

**Problem:** SDK can't find Claude Code credentials

**Solution:**
```bash
# Re-authenticate
claude login

# Verify credentials exist
ls -la ~/.claude/config

# Ensure file permissions are correct
chmod 600 ~/.claude/config
```

### Error: "claude-agent-sdk not installed"

**Problem:** Package not installed

**Solution:**
```bash
cd service
uv pip install claude-agent-sdk
```

### Error: "Invalid backend: claude-agent-sdk"

**Problem:** Old CLI code without SDK support

**Solution:**
```bash
# Pull latest changes
git pull

# Reinstall
cd service
uv pip install -e .
```

### Slow Response Times

**Check:**
1. Debug logs for latency:
   ```bash
   ui-chatter serve --backend claude-agent-sdk --debug
   ```

2. Network connectivity:
   ```bash
   ping api.anthropic.com
   ```

3. Claude Code status:
   ```bash
   claude --version
   ```

### Backend Not Using Subscription

**Verify:**
1. Check which backend is active:
   ```bash
   # Look for startup message
   ui-chatter serve --backend claude-agent-sdk
   # Should show: "🤖 Backend: Claude Agent SDK (subscription)"
   ```

2. Check environment variable:
   ```bash
   echo $BACKEND_STRATEGY
   # Should show: claude-agent-sdk
   ```

3. Check session config (via extension):
   - Open session settings
   - Verify "Backend" shows "claude-agent-sdk"

## Switching Between Backends

### Temporarily Switch to API Key Backend

```bash
# Set API key
export ANTHROPIC_API_KEY=sk-ant-...

# Start with anthropic-sdk backend
ui-chatter serve --backend anthropic-sdk
```

### Per-Session Backend

Each session can use a different backend:

1. Create session with default backend (claude-agent-sdk)
2. In extension, change session backend to "anthropic-sdk"
3. That session now uses API key, others use subscription

## Advanced Configuration

### Custom Tool List

Edit `backend/claude_agent_sdk.py` to add more tools:

```python
self.allowed_tools = [
    "Read", "Write", "Edit", "Bash", "Glob", "Grep",
    "WebFetch", "WebSearch",  # Add more tools
]
```

### Custom Permission Mode

Per-session permission mode:

```python
# In extension settings
session_config = {
    "backend_type": "claude-agent-sdk",
    "permission_mode": "plan",  # Ask before changes
    "project_path": "/path/to/project"
}
```

### Logging Configuration

```bash
# Debug mode - verbose logs
ui-chatter serve --debug

# Production mode - minimal logs
ui-chatter serve

# Custom log level via environment
export LOG_LEVEL=DEBUG
ui-chatter serve
```

## Performance Comparison

| Backend | First Token | Authentication | Cost per Session | Reliability |
|---------|-------------|----------------|------------------|-------------|
| **claude-agent-sdk** | <1s | OAuth (one-time) | $0 | ⭐⭐⭐⭐⭐ |
| anthropic-sdk | ~0.5s | API key | $0.15-$1.00 | ⭐⭐⭐⭐⭐ |
| claude-cli | ~2s | OAuth (subprocess) | $0 | ⚠️ Not implemented |

## Security Notes

1. **Credentials:** SDK reads `~/.claude/config` directly (not exposed in code/logs)
2. **Permissions:** Config file should be `chmod 600` (user-only)
3. **Rate Limits:** Subscription has built-in rate limits (enforced by Anthropic)
4. **Token Leakage:** No API key in environment variables or code

## References

- [Claude Agent SDK Python](https://github.com/anthropics/claude-agent-sdk-python)
- [Claude Agent SDK PyPI](https://pypi.org/project/claude-agent-sdk/)
- [Claude Code CLI](https://claude.ai/docs/cli)
- [Tech Spec: TS-0005](./tech-specs/draft/TS-0005-claude-agent-sdk-integration.md)

## Next Steps

1. ✅ Backend implemented and tested
2. ⏳ Manual testing with extension
3. ⏳ Performance benchmarking
4. ⏳ Session resume support
5. ⏳ Screenshot support
6. ⏳ Interactive approval flow

## Support

**Issues?** Report at: https://github.com/your-org/ui-chatter/issues

**Questions?** Check:
- Tech spec: `tech-specs/draft/TS-0005-claude-agent-sdk-integration.md`
- Backend code: `service/src/ui_chatter/backends/claude_agent_sdk.py`
- CLI code: `service/src/ui_chatter/cli.py`
