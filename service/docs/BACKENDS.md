# Backend Strategies

UI Chatter supports multiple backends for communicating with Claude. Each backend has different authentication requirements and use cases.

## Available Backends

### 1. Claude Code CLI (Recommended)

**Strategy:** `claude-cli`

Uses the Claude Code command-line interface directly, leveraging your existing Claude Code authentication.

**Benefits:**
- No API key needed - uses your Claude Code OAuth authentication
- Same model and capabilities as Claude Code terminal
- Automatically inherits Claude Code configuration and settings
- Free tier usage follows your Claude Code account limits

**Requirements:**
- Claude Code CLI installed and authenticated
- `claude` command available in PATH

**When to use:**
- Local development
- When you already use Claude Code
- When you want to avoid managing API keys
- Personal projects

**Configuration:**
```bash
# .env or .env.local
BACKEND_STRATEGY=claude-cli
```

**CLI:**
```bash
ui-chatter serve --backend claude-cli
# or simply:
ui-chatter serve  # claude-cli is the default
```

### 2. Anthropic SDK

**Strategy:** `anthropic-sdk`

Direct API calls to Anthropic's API using the official Python SDK.

**Benefits:**
- Direct API access
- Better for production deployments
- More control over rate limits and quotas
- Works without Claude Code installed

**Requirements:**
- Anthropic API key from console.anthropic.com
- API key must be set in environment

**When to use:**
- Production deployments
- CI/CD environments
- When Claude Code is not available
- Team/organizational use cases

**Configuration:**
```bash
# .env.local (gitignored)
BACKEND_STRATEGY=anthropic-sdk
ANTHROPIC_API_KEY=sk-ant-...
```

**CLI:**
```bash
ui-chatter serve --backend anthropic-sdk
```

## Comparison

| Feature | claude-cli | anthropic-sdk |
|---------|-----------|---------------|
| Authentication | OAuth (Claude Code) | API Key |
| Setup Complexity | Low | Medium |
| Production Ready | No | Yes |
| Cost | Free tier | Paid API |
| Latency | ~same | ~same |
| Requires Claude Code | Yes | No |

## Switching Backends

You can switch backends in several ways:

### 1. Environment Variables

```bash
# .env.local
BACKEND_STRATEGY=claude-cli  # or anthropic-sdk
```

### 2. CLI Flag

```bash
ui-chatter serve --backend claude-cli
ui-chatter serve --backend anthropic-sdk
```

### 3. Runtime Environment

```bash
BACKEND_STRATEGY=claude-cli ui-chatter serve
```

## Implementation Details

All backends implement the same `AgentBackend` interface:

```python
class AgentBackend(ABC):
    @abstractmethod
    async def handle_chat(
        self,
        context: CapturedContext,
        message: str,
        screenshot_path: Optional[str] = None,
    ) -> AsyncGenerator[dict, None]:
        """Stream response from Claude."""
        pass

    @abstractmethod
    async def shutdown(self) -> None:
        """Cleanup resources."""
        pass
```

This ensures that the WebSocket API remains identical regardless of backend choice.

### Claude CLI Backend

Uses `asyncio.create_subprocess_exec` to spawn `claude` processes:

```python
cmd = [
    "claude",
    "-p",  # Print mode
    "--output-format", "stream-json",
    "--verbose",
    "--project", project_path,
]
```

Parses JSON streaming output and yields response chunks.

### Anthropic SDK Backend

Uses the official `anthropic` Python SDK:

```python
async with client.messages.stream(
    model="claude-sonnet-4-20250514",
    max_tokens=4096,
    messages=[{"role": "user", "content": prompt}],
) as stream:
    async for text in stream.text_stream:
        yield {"type": "response_chunk", "content": text, "done": False}
```

## Adding New Backends

To add a new backend:

1. Create a new class inheriting from `AgentBackend` in `src/ui_chatter/backends/`
2. Implement `handle_chat()` and `shutdown()` methods
3. Add the backend to `BACKEND_STRATEGY` enum in `config.py`
4. Update `SessionManager._create_backend()` to instantiate your backend
5. Update CLI validation in `cli.py`
6. Document the new backend here

Example:

```python
# src/ui_chatter/backends/custom.py
from .base import AgentBackend

class CustomBackend(AgentBackend):
    async def handle_chat(self, context, message, screenshot_path):
        # Your implementation
        yield {"type": "response_chunk", "content": "...", "done": False}

    async def shutdown(self):
        # Cleanup
        pass
```

## Troubleshooting

### Claude CLI Backend

**Error: "Claude CLI not found"**
- Install Claude Code: https://docs.anthropic.com/claude/docs/claude-code
- Verify `claude` is in PATH: `which claude`
- Authenticate: `claude login`

**Error: "Authentication failed"**
- Run `claude login` to re-authenticate
- Check macOS Keychain for "Claude Code-credentials"

### Anthropic SDK Backend

**Error: "invalid x-api-key"**
- Verify API key in .env.local: `ANTHROPIC_API_KEY=sk-ant-...`
- Get a new key: https://console.anthropic.com/settings/keys
- Ensure .env.local is loaded (check with `direnv allow` if using direnv)

**Error: "Authentication failed"**
- Check API key is valid and not revoked
- Verify account has available credits
