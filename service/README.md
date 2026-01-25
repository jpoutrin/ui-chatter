# UI Chatter Service

Python FastAPI service for UI Chatter - connecting browser extension to Claude Agent SDK for real-time code modifications.

## Quick Start

### Prerequisites

- Python 3.10 or higher
- UV package manager ([installation](https://github.com/astral-sh/uv#installation))
- Anthropic API key (or Claude Max subscription with OAuth)

### Installation

```bash
# Navigate to service directory
cd service

# Create virtual environment and install dependencies
uv venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate

# Install package in development mode
uv pip install -e .

# Install dev dependencies
uv pip install -e ".[dev]"
```

### Configuration

Create a `.env` file in the service directory:

```bash
# Copy example configuration
cp .env.example .env

# Edit .env and add your Anthropic API key
ANTHROPIC_API_KEY=sk-ant-...
```

### Running the Service

```bash
# Start server on default port 3456
ui-chatter serve

# Specify project directory
ui-chatter serve --project /path/to/your/project

# Enable debug logging
ui-chatter serve --debug

# Custom port
ui-chatter serve --port 8080

# Development mode with auto-reload
ui-chatter serve --reload --debug
```

### Health Check

```bash
# Check if service is running
curl http://localhost:3456/health
```

Expected response:
```json
{
  "status": "ok",
  "service": "UI Chatter",
  "active_sessions": 0,
  "active_connections": 0
}
```

## Development

### Project Structure

```
service/
├── pyproject.toml          # UV project configuration
├── .python-version         # Python version pin
├── .env.example            # Environment configuration template
├── src/
│   └── ui_chatter/
│       ├── main.py         # FastAPI app + lifespan
│       ├── cli.py          # Typer CLI interface
│       ├── websocket.py    # Connection manager
│       ├── agent_manager.py    # Agent SDK lifecycle
│       ├── session_manager.py  # Multi-session support
│       ├── screenshot_store.py # Async screenshot storage
│       ├── config.py       # Pydantic settings
│       ├── exceptions.py   # Custom exceptions
│       ├── logging_config.py   # Logging setup
│       ├── models/         # Data models
│       │   ├── context.py  # UI context models
│       │   ├── messages.py # WebSocket messages
│       │   └── session.py  # Session state
│       └── schemas/        # API schemas
└── tests/
    ├── conftest.py         # Pytest fixtures
    ├── unit/               # Unit tests
    └── integration/        # Integration tests
```

### Running Tests

```bash
# Run all tests with coverage
pytest

# Run unit tests only
pytest tests/unit/

# Run integration tests
pytest tests/integration/

# Run with verbose output
pytest -v

# Generate HTML coverage report
pytest --cov-report=html
open htmlcov/index.html
```

### Code Quality

```bash
# Format code with Black
black src/ tests/

# Lint with Ruff
ruff check src/ tests/

# Type checking with Mypy
mypy src/
```

## Architecture

### Key Components

1. **ConnectionManager** (`websocket.py`)
   - Validates WebSocket origins (chrome-extension:// only)
   - Manages connection lifecycle
   - Enforces connection limits

2. **AgentManager** (`agent_manager.py`)
   - Lazy initialization of Claude client
   - Streams responses with error handling
   - Graceful shutdown

3. **SessionManager** (`session_manager.py`)
   - Isolates sessions per browser tab
   - Automatic idle session cleanup
   - Resource management

4. **ScreenshotStore** (`screenshot_store.py`)
   - Async screenshot saving
   - Automatic old file cleanup
   - Non-blocking I/O

### WebSocket Protocol

**Client → Server:**
```json
{
  "type": "chat",
  "context": {
    "element": { "tagName": "button", "id": "submit", ... },
    "page": { "url": "http://localhost:3000" }
  },
  "screenshot": "data:image/png;base64,...",
  "message": "make this blue"
}
```

**Server → Client:**
```json
{
  "type": "response_chunk",
  "content": "To make the button blue...",
  "done": false
}
```

## Configuration

Environment variables (`.env` file):

| Variable | Default | Description |
|----------|---------|-------------|
| `DEBUG` | `false` | Enable debug logging |
| `HOST` | `localhost` | Bind address |
| `PORT` | `3456` | WebSocket port |
| `LOG_LEVEL` | `INFO` | Logging level |
| `ANTHROPIC_API_KEY` | - | Claude API key |
| `MAX_SCREENSHOT_AGE_HOURS` | `24` | Screenshot retention |
| `MAX_SESSION_IDLE_MINUTES` | `30` | Session timeout |
| `MAX_CONNECTIONS` | `100` | Max concurrent connections |

## Troubleshooting

### Service won't start

```bash
# Check if port is already in use
lsof -i :3456

# Try a different port
ui-chatter serve --port 8080
```

### Authentication errors

1. Check your API key in `.env`
2. Verify API key is valid: `curl https://api.anthropic.com/v1/messages -H "x-api-key: $ANTHROPIC_API_KEY"`
3. For Claude Max, ensure OAuth is configured

### Connection issues

1. Check WebSocket origin in browser extension
2. Verify CORS settings
3. Check browser console for errors

## Performance

- **First token latency**: < 1 second (vs 60s with ACP)
- **Memory footprint**: < 500MB idle
- **Max concurrent connections**: 100 (configurable)

## Security

- **Origin validation**: Only accepts `chrome-extension://` origins
- **API key**: Stored in `.env` (not committed to git)
- **Project isolation**: Each session is scoped to project directory
- **Auto-cleanup**: Screenshots and sessions cleaned up automatically

## License

See parent project LICENSE.
