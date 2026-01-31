# TS-0007: Project Files & Commands REST API

**Status**: DRAFT (Revised based on Agent SDK sessions review)
**Tech Spec ID**: TS-0007
**Title**: Project Files & Commands REST API Endpoints
**Created**: 2026-01-30
**Last Updated**: 2026-01-30 (Revised to clarify two-layer session architecture)
**Author**: Claude Code
**Decision Reference**: None
**Implements RFC**: None
**Related Specs**: TS-0005, TS-0006
**References**: [Agent SDK Sessions](https://platform.claude.com/docs/en/agent-sdk/sessions)

---

## Executive Summary

### Problem Statement

Browser-based Claude Code clients need efficient ways to:

1. **Discover Project Files**: Browse project structure for context selection, file references, and navigation
2. **Discover Available Commands**: Surface agent slash commands (`/commit`, `/review-pr`) and shell commands (`npm test`, `pytest`) for autocomplete and quick access
3. **Support Dual Command Types**:
   - Agent commands when user types `/` (coding agent features)
   - Shell commands when user types `!` (project script execution)

Currently, these capabilities don't exist - users must manually type file paths and command names without any discovery mechanism.

### Proposed Solution

Implement two new REST API endpoints:

1. **File Listing API** (`GET /api/v1/projects/{session_id}/files`)
   - Async filesystem traversal with `.gitignore` support
   - Pattern matching via glob patterns
   - Prefix filtering for autocomplete
   - In-memory TTL cache (30s)

2. **Commands Discovery API** (`GET /api/v1/projects/{session_id}/commands`)
   - **Dual-mode support**: `mode=agent|shell|all`
   - Agent commands: Parse `.claude/skills/` directory
   - Shell commands: Parse `pyproject.toml`, `package.json`
   - Per-mode caching with appropriate TTLs

### Success Metrics

| Metric | Target |
|--------|--------|
| File listing performance | < 100ms for typical projects |
| Commands discovery performance | < 50ms for agent mode (cached) |
| Gitignore accuracy | 100% pattern compliance |
| Cache hit rate | > 80% |
| Session isolation | 100% (no cross-session leakage) |

### Scope

**In Scope:**
- File listing with gitignore support
- Glob pattern filtering
- Prefix-based autocomplete
- Agent command discovery (slash commands)
- Shell command discovery (project scripts)
- Dual-mode command interface
- In-memory caching
- Session validation and isolation

**Out of Scope:**
- File content preview (metadata only)
- File watching / change notifications
- Fuzzy search
- Command execution (only discovery)
- Authentication beyond session validation
- Pagination (simple limit-based for MVP)

---

## Architecture Overview

### System Context

```
┌────────────────────────────────────────────────────────────┐
│                      SYSTEM CONTEXT                        │
└────────────────────────────────────────────────────────────┘

Browser Extension          REST API              Filesystem
─────────────────          ────────              ──────────

Autocomplete UI     ──►   GET /files     ──►    .gitignore
  ├─ File paths            + pattern              parsing
  │                        + prefix          ──►  Directory
  │                        + limit                traversal
  │
Command palette     ──►   GET /commands   ──►   .claude/skills/
  ├─ /commit              + mode=agent           SKILL.md
  ├─ /review-pr           + prefix          ──►  pyproject.toml
  │                       + limit           ──►  package.json
  └─ ! npm test
```

### Component Architecture

```
┌────────────────────────────────────────────────────────────┐
│                    COMPONENT ARCHITECTURE                  │
└────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                         FastAPI App                         │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  /api/v1/projects/{session_id}/files                        │
│    ├─ Validate session                                      │
│    ├─ ProjectFileLister                                     │
│    │   ├─ Load .gitignore (pathspec)                        │
│    │   ├─ Walk directory tree (asyncio)                     │
│    │   ├─ Apply pattern filter                              │
│    │   ├─ Apply prefix filter                               │
│    │   └─ Check cache (TTL: 30s)                            │
│    └─ Return JSON                                           │
│                                                             │
│  /api/v1/projects/{session_id}/commands                     │
│    ├─ Validate session                                      │
│    ├─ CommandDiscovery                                      │
│    │   ├─ Agent Mode (mode=agent)                           │
│    │   │   ├─ Parse .claude/skills/                         │
│    │   │   ├─ Read SKILL.md files                           │
│    │   │   └─ Cache (TTL: session lifetime)                 │
│    │   ├─ Shell Mode (mode=shell)                           │
│    │   │   ├─ Parse pyproject.toml                          │
│    │   │   ├─ Parse package.json                            │
│    │   │   └─ Cache (TTL: 60s)                              │
│    │   └─ All Mode (merge both)                             │
│    └─ Return JSON                                           │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Two-Layer Session Architecture

**IMPORTANT**: UI Chatter implements a two-layer session architecture that separates connection management from conversation state:

```
┌─────────────────────────────────────────────────────────────┐
│                   TWO-LAYER SESSION DESIGN                  │
└─────────────────────────────────────────────────────────────┘

Layer 1: WebSocket Session (UI Chatter)
──────────────────────────────────────
  ID:        UUID (generated on connection)
  Purpose:   Connection management, REST API auth
  Storage:   In-memory SessionManager
  Lifetime:  Active WebSocket connection
  Scope:     Project path binding, backend instance

  ▼ Contains ▼

Layer 2: Agent SDK Session (Claude)
────────────────────────────────────
  ID:        Generated by Agent SDK (from init message)
  Purpose:   Conversation state, tool execution history
  Storage:   Agent SDK storage (~/.claude/)
  Lifetime:  Persists beyond WebSocket disconnect
  Scope:     Conversation resumption, file checkpointing

┌─────────────────────────────────────────────────────────────┐
│  REST API Endpoints Use Layer 1 (WebSocket session_id)     │
│  - /files and /commands use WebSocket session_id            │
│  - Agent SDK session ID managed internally by backend       │
│  - Session resumption NOT exposed in REST API (future)      │
└─────────────────────────────────────────────────────────────┘
```

**Why Two Layers?**

| Concern | WebSocket Session | Agent SDK Session |
|---------|------------------|-------------------|
| **API Authentication** | ✅ Used | ❌ Not exposed |
| **Project Binding** | ✅ Stores project_path | ❌ N/A |
| **Conversation Resumption** | ❌ Lost on disconnect | ✅ Persists |
| **REST API Access** | ✅ Required | ❌ Internal only |
| **Browser Extension** | ✅ Tracks connection | ❌ Hidden |

**Implications for REST API:**
- The `{session_id}` path parameter refers to **WebSocket session**, not Agent SDK session
- Each WebSocket connection creates a new Agent SDK backend instance
- Agent SDK sessions are managed internally and not exposed via REST API
- Future enhancement: Add endpoints to list/resume Agent SDK sessions

---

## Design Details

### Endpoint 1: Project Files Listing

#### API Specification

**Endpoint**: `GET /api/v1/projects/{session_id}/files`

**Path Parameters**:
- `session_id` (string, required): Active **WebSocket session** identifier (UUID generated on connection, NOT Agent SDK session ID)

**Query Parameters**:
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `pattern` | string | No | None | Glob pattern (e.g., `**/*.py`) |
| `prefix` | string | No | None | Path prefix for autocomplete (e.g., `src/ui_chatter/`) |
| `limit` | integer | No | 100 | Maximum number of files to return |

**Response Schema** (200 OK):
```json
{
  "session_id": "abc-123",
  "project_path": "/Users/user/project",
  "file_count": 42,
  "total_files": 42,
  "files": [
    {
      "relative_path": "src/ui_chatter/main.py",
      "size": 13709,
      "modified_at": 1738252980.0,
      "type": "file"
    }
  ],
  "truncated": false
}
```

**Error Responses**:
- `404 Not Found`: Session not found
- `500 Internal Server Error`: Filesystem error

#### Implementation: `ProjectFileLister`

**File**: `service/src/ui_chatter/project_files.py`

**Class Structure**:
```python
class ProjectFileLister:
    DEFAULT_EXCLUSIONS = {
        ".git", "node_modules", "__pycache__",
        ".venv", "venv", ".pytest_cache", ...
    }

    def __init__(self, project_path: str, use_gitignore: bool = True)
    def _load_gitignore() -> Optional[pathspec.PathSpec]
    def _should_exclude(path: Path) -> bool
    async def _walk_directory(max_depth: int = 10) -> List[dict]
    async def list_files(pattern, prefix, limit) -> dict
```

**Key Features**:
1. **Gitignore Parsing**: Uses `pathspec.PathSpec.from_lines()` to parse `.gitignore`
2. **Default Exclusions**: Hard-coded list of common directories to skip
3. **Path Security**: Always resolves paths and validates within project root
4. **Async Traversal**: Uses `pathlib` with async wrapper for non-blocking I/O
5. **Caching**: Simple in-memory dict with `(pattern, prefix)` as key and 30s TTL

**Caching Strategy**:
```python
self._cache: Dict[Tuple[Optional[str], Optional[str]], Tuple[dict, float]] = {}
cache_key = (pattern, prefix)
if cache_key in self._cache:
    result, timestamp = self._cache[cache_key]
    if time.time() - timestamp < 30:
        return result
```

---

### Endpoint 2: Commands Discovery (Dual Mode)

#### API Specification

**Endpoint**: `GET /api/v1/projects/{session_id}/commands`

**Path Parameters**:
- `session_id` (string, required): Active **WebSocket session** identifier (UUID generated on connection, NOT Agent SDK session ID)

**Query Parameters**:
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `mode` | string | No | `"agent"` | Command type: `"agent"`, `"shell"`, or `"all"` |
| `prefix` | string | No | None | Filter by name/command prefix |
| `limit` | integer | No | 50 | Maximum number of commands to return |

**Response Schema** (200 OK):
```json
{
  "session_id": "abc-123",
  "mode": "agent",
  "command_count": 5,
  "commands": [
    {
      "name": "commit",
      "command": "/commit",
      "description": "Guided git commit with atomic commit analysis",
      "category": "git-workflow",
      "mode": "agent"
    }
  ]
}
```

**Error Responses**:
- `400 Bad Request`: Invalid mode parameter
- `404 Not Found`: Session not found
- `500 Internal Server Error`: Command discovery error

#### Implementation: `CommandDiscovery`

**File**: `service/src/ui_chatter/commands_discovery.py`

**Class Structure**:
```python
class Command(BaseModel):
    name: str
    command: str
    description: Optional[str] = None
    category: Optional[str] = None
    mode: str  # "agent" or "shell"

class CommandDiscovery:
    def __init__(self, project_path: str, backend: AgentBackend)
    async def discover_commands(mode: str) -> List[Command]
    async def _discover_agent_commands() -> List[Command]
    async def _discover_shell_commands() -> List[Command]
    def _fallback_agent_commands() -> List[Command]
    def _parse_skill_description(skill_md: Path) -> Optional[str]
    def _parse_pyproject_toml() -> List[Command]
    def _parse_package_json() -> List[Command]
```

#### Agent Commands Discovery (`mode="agent"`)

**Strategy**: Parse `.claude/skills/` directory structure (filesystem-based)

**Why Filesystem Parsing?**
- Agent SDK query approach would require sending a prompt and parsing JSON response
- Filesystem parsing is faster, more reliable, and doesn't consume API tokens
- Skills directory structure is well-defined and stable
- Fallback approach proven to work reliably

**Search Paths**:
1. `{project_path}/.claude/skills/` (project-level)
2. `~/.claude/skills/` (user-level)

**Discovery Process**:
```
For each directory in skills/:
  1. Check if SKILL.md exists
  2. Parse skill name from directory name
  3. Extract description from SKILL.md (YAML frontmatter or first line)
  4. Create Command with:
     - name: "commit"
     - command: "/commit"
     - description: from SKILL.md
     - category: "skills"
     - mode: "agent"
```

**SKILL.md Parsing**:
```python
# Look for YAML frontmatter
frontmatter_match = re.search(r"^---\s*\n(.*?)\n---", content, re.MULTILINE | re.DOTALL)
if frontmatter_match:
    yaml_content = frontmatter_match.group(1)
    desc_match = re.search(r"description:\s*(.+)", yaml_content)
    if desc_match:
        return desc_match.group(1).strip()

# Fallback: First non-empty line after frontmatter
```

**Caching**: Cache per session lifetime (commands rarely change during a session)

#### Shell Commands Discovery (`mode="shell"`)

**Strategy**: Parse project config files for script definitions

**Supported Formats**:

1. **pyproject.toml** (`[project.scripts]`):
```toml
[project.scripts]
ui-chatter = "ui_chatter.cli:app"
```
→ Command(name="ui-chatter", command="ui-chatter", category="pyproject.toml", mode="shell")

2. **package.json** (`"scripts"`):
```json
{
  "scripts": {
    "test": "jest",
    "build": "webpack"
  }
}
```
→ Command(name="test", command="npm run test", category="package.json", mode="shell")

**Parsing Implementation**:
```python
# pyproject.toml
if sys.version_info >= (3, 11):
    import tomllib
else:
    import tomli as tomllib

with open(pyproject_path, "rb") as f:
    data = tomllib.load(f)
scripts = data.get("project", {}).get("scripts", {})

# package.json
with open(package_json_path, "r", encoding="utf-8") as f:
    data = json.load(f)
scripts = data.get("scripts", {})
```

**Caching**: Cache with 60s TTL (scripts may change during development)

#### Mode Handling

**Mode Parameter Behavior**:
- `mode="agent"`: Only agent commands (slash commands)
- `mode="shell"`: Only shell commands (project scripts)
- `mode="all"`: Both, merged and sorted by name
- Invalid mode → `400 Bad Request`

**Use Cases**:
| User Input | Mode | Purpose |
|------------|------|---------|
| Types `/` | `agent` | Show coding agent commands |
| Types `!` | `shell` | Show project scripts |
| General palette | `all` | Show everything |

---

## Security Considerations

### 1. Path Traversal Protection

**Risk**: Malicious session could request files outside project directory

**Mitigation**:
```python
# Always resolve and validate paths
self.project_path = Path(project_path).resolve()

# Check if path is within project
try:
    rel_path = path.relative_to(self.project_path)
except ValueError:
    return True  # Exclude paths outside project
```

**Test Case**: Attempt to list `../../../etc/passwd` → Should be excluded

### 2. Session Validation

**Risk**: Unauthorized access to session data

**Mitigation**:
```python
session = await session_manager.get_session(session_id)
if not session:
    raise HTTPException(status_code=404, detail="Session not found")
```

**Guarantee**: Each session isolated to its `project_path`

### 3. Resource Limits

**Risk**: Filesystem exhaustion or memory overflow

**Mitigation**:
- `max_depth=10` for directory traversal (prevent infinite loops)
- `limit` parameter enforced on all queries
- Cache TTL prevents unbounded memory growth
- Graceful handling of permission errors

### 4. Sensitive File Exclusion

**Risk**: Exposing credentials or secrets

**Mitigation**:
- Hard-coded exclusions: `.git/`, `.env`, `node_modules/`
- Respect `.gitignore` by default
- Only list metadata (never file content in this endpoint)

**Default Exclusions**:
```python
DEFAULT_EXCLUSIONS = {
    ".git", "node_modules", "__pycache__",
    ".venv", "venv", ".env", ...
}
```

### 5. Command Injection Protection

**Risk**: Shell command execution via discovered commands

**Scope**: This endpoint only **discovers** commands, does NOT execute them
- Commands are strings, not executed by this API
- Execution (if added later) requires separate permission checks

### 6. Agent SDK Session Persistence

**Risk**: Agent SDK sessions persist beyond WebSocket lifetime in `~/.claude/` storage

**Context**:
- WebSocket sessions (Layer 1) are ephemeral - destroyed on disconnect
- Agent SDK sessions (Layer 2) persist in local storage after disconnect
- Agent SDK sessions contain conversation history, file paths, tool execution context

**Security Implications**:
- Old Agent SDK sessions may contain sensitive file paths
- Session history accessible if someone gains access to `~/.claude/` directory
- Sessions not explicitly cleaned up on WebSocket disconnect

**Current Mitigation**:
- Agent SDK session IDs not exposed via REST API
- Each WebSocket connection creates isolated backend instance
- Sessions managed by Agent SDK's built-in storage

**Future Considerations**:
- Consider using `fork_session=True` to isolate each WebSocket connection
- Implement explicit Agent SDK session cleanup on disconnect
- Add REST API endpoints to list/manage persisted Agent SDK sessions
- Document that Agent SDK sessions may persist for resumption purposes

**Recommendation**:
For high-security environments, consider implementing Agent SDK session cleanup or using ephemeral session storage that doesn't persist to disk.

---

## Testing Strategy

### Manual Testing

**Prerequisites**:
1. Start service: `ui-chatter serve`
2. Create session via WebSocket connection

**Test Cases**:

#### File Listing Tests
```bash
# Test 1: List all files
curl "http://localhost:8000/api/v1/projects/{session_id}/files"

# Test 2: Filter by pattern
curl "http://localhost:8000/api/v1/projects/{session_id}/files?pattern=**/*.py"

# Test 3: Autocomplete prefix
curl "http://localhost:8000/api/v1/projects/{session_id}/files?prefix=src/ui_chatter/"

# Test 4: Limit enforcement
curl "http://localhost:8000/api/v1/projects/{session_id}/files?limit=5"

# Test 5: Invalid session
curl "http://localhost:8000/api/v1/projects/invalid-session/files"
# Expected: 404 Not Found
```

#### Commands Discovery Tests
```bash
# Test 1: Agent commands (default)
curl "http://localhost:8000/api/v1/projects/{session_id}/commands"

# Test 2: Shell commands
curl "http://localhost:8000/api/v1/projects/{session_id}/commands?mode=shell"

# Test 3: All commands
curl "http://localhost:8000/api/v1/projects/{session_id}/commands?mode=all"

# Test 4: Filter by prefix (agent)
curl "http://localhost:8000/api/v1/projects/{session_id}/commands?mode=agent&prefix=/commit"

# Test 5: Filter by prefix (shell)
curl "http://localhost:8000/api/v1/projects/{session_id}/commands?mode=shell&prefix=test"

# Test 6: Invalid mode
curl "http://localhost:8000/api/v1/projects/{session_id}/commands?mode=invalid"
# Expected: 400 Bad Request
```

### Unit Tests

**File**: `service/tests/unit/test_project_files.py`

```python
import pytest
from ui_chatter.project_files import ProjectFileLister

@pytest.mark.asyncio
async def test_gitignore_parsing(tmp_path):
    """Test .gitignore pattern parsing"""
    gitignore = tmp_path / ".gitignore"
    gitignore.write_text("*.pyc\n__pycache__/\n")

    lister = ProjectFileLister(str(tmp_path))
    assert lister.gitignore_spec is not None

@pytest.mark.asyncio
async def test_pattern_matching(tmp_path):
    """Test glob pattern filtering"""
    (tmp_path / "test.py").touch()
    (tmp_path / "test.js").touch()

    lister = ProjectFileLister(str(tmp_path))
    result = await lister.list_files(pattern="**/*.py")

    assert result["file_count"] == 1
    assert result["files"][0]["relative_path"] == "test.py"

@pytest.mark.asyncio
async def test_prefix_filtering(tmp_path):
    """Test prefix-based autocomplete"""
    (tmp_path / "src" / "main.py").mkdir(parents=True).touch()
    (tmp_path / "tests" / "test.py").mkdir(parents=True).touch()

    lister = ProjectFileLister(str(tmp_path))
    result = await lister.list_files(prefix="src/")

    assert result["file_count"] == 1
    assert result["files"][0]["relative_path"].startswith("src/")

@pytest.mark.asyncio
async def test_cache_behavior(tmp_path):
    """Test TTL caching"""
    lister = ProjectFileLister(str(tmp_path))

    # First call
    result1 = await lister.list_files()

    # Second call (should hit cache)
    result2 = await lister.list_files()

    assert result1 == result2
    assert len(lister._cache) == 1
```

**File**: `service/tests/unit/test_commands_discovery.py`

```python
import pytest
from ui_chatter.commands_discovery import CommandDiscovery, Command

@pytest.mark.asyncio
async def test_agent_commands_discovery(tmp_path, mock_backend):
    """Test agent command discovery from .claude/skills/"""
    skills_dir = tmp_path / ".claude" / "skills" / "commit"
    skills_dir.mkdir(parents=True)

    skill_md = skills_dir / "SKILL.md"
    skill_md.write_text("""---
description: Guided git commit
---
""")

    discovery = CommandDiscovery(str(tmp_path), mock_backend)
    commands = await discovery.discover_commands(mode="agent")

    assert len(commands) > 0
    assert any(cmd.name == "commit" for cmd in commands)

@pytest.mark.asyncio
async def test_shell_commands_pyproject(tmp_path, mock_backend):
    """Test shell command discovery from pyproject.toml"""
    pyproject = tmp_path / "pyproject.toml"
    pyproject.write_text("""
[project.scripts]
ui-chatter = "ui_chatter.cli:app"
test = "pytest"
""")

    discovery = CommandDiscovery(str(tmp_path), mock_backend)
    commands = await discovery.discover_commands(mode="shell")

    assert len(commands) == 2
    assert any(cmd.name == "ui-chatter" for cmd in commands)
    assert any(cmd.name == "test" for cmd in commands)

@pytest.mark.asyncio
async def test_shell_commands_package_json(tmp_path, mock_backend):
    """Test shell command discovery from package.json"""
    package_json = tmp_path / "package.json"
    package_json.write_text("""
{
  "scripts": {
    "test": "jest",
    "build": "webpack"
  }
}
""")

    discovery = CommandDiscovery(str(tmp_path), mock_backend)
    commands = await discovery.discover_commands(mode="shell")

    assert len(commands) == 2
    assert all(cmd.command.startswith("npm run") for cmd in commands)

@pytest.mark.asyncio
async def test_mode_parameter_handling(tmp_path, mock_backend):
    """Test mode parameter: agent, shell, all"""
    discovery = CommandDiscovery(str(tmp_path), mock_backend)

    agent_cmds = await discovery.discover_commands(mode="agent")
    shell_cmds = await discovery.discover_commands(mode="shell")
    all_cmds = await discovery.discover_commands(mode="all")

    assert len(all_cmds) >= len(agent_cmds) + len(shell_cmds)

@pytest.mark.asyncio
async def test_prefix_filtering(tmp_path, mock_backend):
    """Test command filtering by prefix"""
    # Test handled in endpoint layer, not CommandDiscovery
    pass
```

### Integration Tests

**File**: `service/tests/integration/test_project_endpoints.py`

```python
import pytest
from httpx import AsyncClient

@pytest.mark.integration
async def test_file_listing_endpoint(client: AsyncClient, test_session_id):
    """Test full file listing flow"""
    response = await client.get(
        f"/api/v1/projects/{test_session_id}/files?limit=10"
    )

    assert response.status_code == 200
    data = response.json()
    assert "session_id" in data
    assert "files" in data
    assert data["file_count"] <= 10

@pytest.mark.integration
async def test_commands_endpoint_agent_mode(client: AsyncClient, test_session_id):
    """Test agent commands discovery"""
    response = await client.get(
        f"/api/v1/projects/{test_session_id}/commands?mode=agent"
    )

    assert response.status_code == 200
    data = response.json()
    assert data["mode"] == "agent"
    assert all(cmd["mode"] == "agent" for cmd in data["commands"])

@pytest.mark.integration
async def test_commands_endpoint_shell_mode(client: AsyncClient, test_session_id):
    """Test shell commands discovery"""
    response = await client.get(
        f"/api/v1/projects/{test_session_id}/commands?mode=shell"
    )

    assert response.status_code == 200
    data = response.json()
    assert data["mode"] == "shell"
    assert all(cmd["mode"] == "shell" for cmd in data["commands"])

@pytest.mark.integration
async def test_invalid_session_returns_404(client: AsyncClient):
    """Test error handling for invalid session"""
    response = await client.get(
        "/api/v1/projects/invalid-session-id/files"
    )

    assert response.status_code == 404
    assert "Session not found" in response.json()["detail"]

@pytest.mark.integration
async def test_invalid_mode_returns_400(client: AsyncClient, test_session_id):
    """Test error handling for invalid mode"""
    response = await client.get(
        f"/api/v1/projects/{test_session_id}/commands?mode=invalid"
    )

    assert response.status_code == 400
    assert "Invalid mode" in response.json()["detail"]
```

---

## Deployment Plan

### Phase 1: Implementation (Completed)

**Files Created**:
- ✅ `service/src/ui_chatter/project_files.py` (ProjectFileLister)
- ✅ `service/src/ui_chatter/commands_discovery.py` (CommandDiscovery)

**Files Modified**:
- ✅ `service/pyproject.toml` (added `pathspec>=0.12.0`)
- ✅ `service/src/ui_chatter/main.py` (added REST endpoints)
- ✅ `service/src/ui_chatter/config.py` (added cache/limit settings)

**Dependencies Installed**:
```bash
cd service && uv pip install -e .
```

### Phase 2: Manual Verification

**Verification Steps**:

1. **Service Starts**:
```bash
ui-chatter serve
# Should start without import errors
```

2. **Health Check**:
```bash
curl http://localhost:8000/health
# Expected: {"status": "ok", ...}
```

3. **Create Session** (via WebSocket):
```javascript
// In browser extension
const ws = new WebSocket("ws://localhost:8000/ws");
ws.send(JSON.stringify({type: "handshake", permission_mode: "bypassPermissions"}));
// Extract session_id from connection
```

4. **Test File Listing**:
```bash
curl "http://localhost:8000/api/v1/projects/{session_id}/files?limit=5"
# Expected: JSON with files array
```

5. **Test Agent Commands**:
```bash
curl "http://localhost:8000/api/v1/projects/{session_id}/commands?mode=agent"
# Expected: JSON with slash commands
```

6. **Test Shell Commands**:
```bash
curl "http://localhost:8000/api/v1/projects/{session_id}/commands?mode=shell"
# Expected: JSON with project scripts
```

7. **Verify Gitignore**:
```bash
# Check that .git/, node_modules/, __pycache__ are excluded
curl "http://localhost:8000/api/v1/projects/{session_id}/files" | jq '.files[].relative_path'
```

8. **Test Error Cases**:
```bash
# Invalid session
curl "http://localhost:8000/api/v1/projects/invalid/files"
# Expected: 404

# Invalid mode
curl "http://localhost:8000/api/v1/projects/{session_id}/commands?mode=invalid"
# Expected: 400
```

### Phase 3: Unit Tests (Optional Follow-up)

**Create Test Files**:
- `service/tests/unit/test_project_files.py`
- `service/tests/unit/test_commands_discovery.py`

**Run Tests**:
```bash
cd service
pytest tests/unit/ -v
```

### Phase 4: Integration Tests (Optional Follow-up)

**Create Test File**:
- `service/tests/integration/test_project_endpoints.py`

**Run Tests**:
```bash
cd service
pytest tests/integration/ -v --integration
```

### Phase 5: Frontend Integration (Future Work)

**Browser Extension Changes**:
1. Add autocomplete for file paths using `/files` endpoint
2. Add command palette with dual-mode support:
   - User types `/` → Query `mode=agent`
   - User types `!` → Query `mode=shell`
3. Cache responses in extension storage

**Not in Scope**: Frontend changes are tracked separately

---

## Edge Cases

### File Listing Edge Cases

| Case | Behavior |
|------|----------|
| Empty project | Return `{file_count: 0, files: []}` |
| No .gitignore | Use DEFAULT_EXCLUSIONS only |
| Permission denied | Skip inaccessible files, log warning, continue |
| Symbolic links | Follow but prevent infinite loops via max_depth |
| Binary files | Include in listing (no content reading) |
| Case sensitivity | Respect OS filesystem behavior |
| Very large project | Respect limit, set truncated=true |

### Commands Discovery Edge Cases

| Case | Behavior |
|------|----------|
| No .claude/skills/ | Return empty list for agent mode |
| No pyproject.toml/package.json | Return empty list for shell mode |
| Malformed TOML/JSON | Log warning, return partial results |
| SKILL.md missing description | Use filename as description |
| Duplicate command names | Keep all (category differentiates) |
| Backend unavailable | Use fallback (filesystem parsing) |

---

## Future Enhancements (Not in MVP)

### Pagination
- Add cursor-based pagination for large result sets
- Response includes `next_cursor` field
- Client sends `?cursor=xxx` for next page

### File Watching
- Add WebSocket notifications for file changes
- Real-time autocomplete updates
- Invalidate cache on detected changes

### Fuzzy Search
- Add fuzzy matching for commands
- Scoring algorithm (e.g., Levenshtein distance)
- Rank results by relevance

### Dynamic Command Discovery
- Use Agent SDK query to discover custom commands
- Parse command definitions from agent responses
- Support plugin-based command extensions

### File Content Preview
- Add optional `?include_snippet=true` parameter
- Return first N lines of file content
- Syntax highlighting hints

### Command History
- Track previously executed commands
- Suggest based on usage frequency
- Per-session or per-user history

### Makefile Support
- Add Makefile target parsing
- Extract target names and descriptions
- Integrate with shell mode

### Agent SDK Session Management
**High Priority**: Expose Agent SDK sessions via REST API

**Missing Endpoints:**
```
GET  /api/v1/agent-sessions                      # List persisted Agent SDK sessions
POST /api/v1/agent-sessions/resume               # Resume an Agent SDK session
POST /api/v1/agent-sessions/{id}/fork            # Fork an Agent SDK session
GET  /api/v1/agent-sessions/{id}/history         # Get conversation history
DELETE /api/v1/agent-sessions/{id}               # Clean up Agent SDK session
```

**Use Cases:**
- Resume previous coding session after browser restart
- Fork session to explore alternative approaches
- View conversation history across WebSocket disconnects
- Clean up old Agent SDK sessions for security

**Implementation Notes:**
- Agent SDK session IDs come from `init` message (not our UUIDs)
- Need to capture and store Agent SDK session IDs from backend
- Session resumption uses `resume` option in Agent SDK query
- Session forking uses `fork_session=True` option

**Reference**: See [Agent SDK Sessions Documentation](https://platform.claude.com/docs/en/agent-sdk/sessions)

---

## Performance Considerations

### File Listing Performance

**Optimization Strategies**:
1. **Caching**: 30s TTL reduces repeated filesystem access
2. **Early Exit**: Stop traversal when limit reached
3. **Lazy Evaluation**: Only stat files that pass exclusion checks
4. **Depth Limit**: Prevent deep recursion (max_depth=10)

**Expected Performance** (typical Python project):
- ~500 files: < 50ms (cold), < 5ms (cached)
- ~5000 files: < 200ms (cold), < 5ms (cached)

### Commands Discovery Performance

**Agent Mode**:
- First request: ~50-100ms (filesystem parsing)
- Subsequent: < 1ms (cached for session lifetime)

**Shell Mode**:
- First request: ~10-20ms (TOML/JSON parsing)
- Subsequent: < 1ms (cached for 60s)

**Cache Memory Usage**:
- File listing: ~1KB per unique (pattern, prefix) combination
- Commands: ~5KB per (session_id, mode) combination
- Total: < 1MB for 100 active sessions

---

## Monitoring and Observability

### Metrics to Track

| Metric | Purpose |
|--------|---------|
| `files_api_request_count` | Total requests to /files endpoint |
| `files_api_response_time` | Latency distribution |
| `files_api_cache_hit_rate` | Cache effectiveness |
| `commands_api_request_count` | Total requests to /commands endpoint |
| `commands_api_response_time` | Latency distribution |
| `commands_api_cache_hit_rate` | Cache effectiveness |

### Logging

**Log Levels**:
- `DEBUG`: Cache hits/misses, gitignore parsing
- `INFO`: API requests, command discovery results
- `WARNING`: Permission errors, parse failures
- `ERROR`: Session not found, filesystem errors

**Example Logs**:
```
INFO: File listing for session abc123: 42 files, pattern=**/*.py
DEBUG: Cache hit for key ('**/*.py', None)
WARNING: Permission denied: /path/to/restricted
ERROR: Failed to parse pyproject.toml: invalid TOML syntax
```

---

## Dependencies

### New Dependencies

**pathspec** (`>=0.12.0`):
- Purpose: `.gitignore` pattern matching
- License: MPL-2.0
- Maintained: Active (last release: 2024)
- Alternatives considered: gitignore-parser (less maintained)

### Python Standard Library

- `pathlib`: Filesystem traversal
- `json`: package.json parsing
- `tomllib` (3.11+) / `tomli` (fallback): pyproject.toml parsing
- `re`: YAML frontmatter parsing
- `time`: Cache TTL management

---

## Rollback Plan

### If Issues Arise

**Steps to Revert**:

1. **Remove endpoints** from `main.py`:
```python
# Comment out or delete:
# @app.get("/api/v1/projects/{session_id}/files")
# @app.get("/api/v1/projects/{session_id}/commands")
```

2. **Remove imports**:
```python
# Remove from main.py:
# from .project_files import ProjectFileLister
# from .commands_discovery import CommandDiscovery, Command
```

3. **Uninstall dependency** (optional):
```bash
uv pip uninstall pathspec
```

4. **Restart service**:
```bash
ui-chatter serve
```

**No Data Loss**: Endpoints are read-only, no state modification

---

## Conclusion

This technical specification defines two REST API endpoints that enable browser clients to:

1. **Discover project files** with intelligent filtering, gitignore support, and efficient caching
2. **Discover available commands** in dual-mode (agent slash commands and shell scripts)

The implementation is:
- ✅ **Complete**: All code written and integrated
- ✅ **Secure**: Session validation, path traversal protection, resource limits
- ✅ **Performant**: In-memory caching, lazy evaluation, depth limits
- ✅ **Extensible**: Easy to add pagination, fuzzy search, file watching later

**Architectural Clarifications** (post-review):
- ⚠️ **Two-Layer Sessions**: Spec now clearly distinguishes WebSocket sessions (REST API auth) from Agent SDK sessions (conversation state)
- ⚠️ **Session ID Scope**: REST API uses WebSocket session_id, NOT Agent SDK session ID
- 📋 **Future Enhancement**: Agent SDK session management API (list, resume, fork) identified as valuable addition

**Next Steps**:
1. Manual verification with curl
2. Unit test implementation (optional)
3. Frontend integration (separate task)
4. Consider implementing Agent SDK session management endpoints (future)

---

## Appendix A: API Response Examples

### File Listing Response

**Request**: `GET /api/v1/projects/abc-123/files?pattern=**/*.py&limit=3`

**Response** (200 OK):
```json
{
  "session_id": "abc-123",
  "project_path": "/Users/user/ui-chatter",
  "file_count": 3,
  "total_files": 42,
  "files": [
    {
      "relative_path": "service/src/ui_chatter/main.py",
      "size": 13709,
      "modified_at": 1738252980.0,
      "type": "file"
    },
    {
      "relative_path": "service/src/ui_chatter/config.py",
      "size": 1824,
      "modified_at": 1738252800.0,
      "type": "file"
    },
    {
      "relative_path": "service/src/ui_chatter/project_files.py",
      "size": 5432,
      "modified_at": 1738253100.0,
      "type": "file"
    }
  ],
  "truncated": true
}
```

### Agent Commands Response

**Request**: `GET /api/v1/projects/abc-123/commands?mode=agent`

**Response** (200 OK):
```json
{
  "session_id": "abc-123",
  "mode": "agent",
  "command_count": 5,
  "commands": [
    {
      "name": "commit",
      "command": "/commit",
      "description": "Guided git commit with atomic commit analysis and conventional commit format",
      "category": "git-workflow",
      "mode": "agent"
    },
    {
      "name": "review-pr",
      "command": "/review-pr",
      "description": "Review code changes between commits for security, logic, performance, and style issues",
      "category": "git-workflow",
      "mode": "agent"
    },
    {
      "name": "design-audit",
      "command": "/design-audit",
      "description": "Analyze a website to extract design tokens and guidelines",
      "category": "product-design",
      "mode": "agent"
    },
    {
      "name": "create-prd",
      "command": "/create-prd",
      "description": "Interactive PRD creation wizard with comprehensive question flow",
      "category": "product-design",
      "mode": "agent"
    },
    {
      "name": "mypy-check",
      "command": "/mypy-check",
      "description": "Run Mypy type checking on Python code with detailed error reporting",
      "category": "python-experts",
      "mode": "agent"
    }
  ]
}
```

### Shell Commands Response

**Request**: `GET /api/v1/projects/abc-123/commands?mode=shell`

**Response** (200 OK):
```json
{
  "session_id": "abc-123",
  "mode": "shell",
  "command_count": 3,
  "commands": [
    {
      "name": "ui-chatter",
      "command": "ui-chatter",
      "description": "Run ui-chatter entrypoint: ui_chatter.cli:app",
      "category": "pyproject.toml",
      "mode": "shell"
    },
    {
      "name": "test",
      "command": "npm run test",
      "description": "Run npm script: jest",
      "category": "package.json",
      "mode": "shell"
    },
    {
      "name": "build",
      "command": "npm run build",
      "description": "Run npm script: webpack --mode production",
      "category": "package.json",
      "mode": "shell"
    }
  ]
}
```

### All Commands Response

**Request**: `GET /api/v1/projects/abc-123/commands?mode=all&limit=5`

**Response** (200 OK):
```json
{
  "session_id": "abc-123",
  "mode": "all",
  "command_count": 5,
  "commands": [
    {
      "name": "build",
      "command": "npm run build",
      "description": "Run npm script: webpack --mode production",
      "category": "package.json",
      "mode": "shell"
    },
    {
      "name": "commit",
      "command": "/commit",
      "description": "Guided git commit",
      "category": "git-workflow",
      "mode": "agent"
    },
    {
      "name": "design-audit",
      "command": "/design-audit",
      "description": "Analyze website design",
      "category": "product-design",
      "mode": "agent"
    },
    {
      "name": "test",
      "command": "npm run test",
      "description": "Run npm script: jest",
      "category": "package.json",
      "mode": "shell"
    },
    {
      "name": "ui-chatter",
      "command": "ui-chatter",
      "description": "Run ui-chatter entrypoint",
      "category": "pyproject.toml",
      "mode": "shell"
    }
  ]
}
```

### Error Response - Session Not Found

**Request**: `GET /api/v1/projects/invalid-session/files`

**Response** (404 Not Found):
```json
{
  "detail": "Session not found"
}
```

### Error Response - Invalid Mode

**Request**: `GET /api/v1/projects/abc-123/commands?mode=invalid`

**Response** (400 Bad Request):
```json
{
  "detail": "Invalid mode. Use 'agent', 'shell', or 'all'"
}
```

---

## Appendix B: File Structure

```
service/
├── src/
│   └── ui_chatter/
│       ├── main.py                  # Modified: Added endpoints
│       ├── config.py                # Modified: Added cache settings
│       ├── project_files.py         # NEW: File listing service
│       └── commands_discovery.py    # NEW: Command discovery service
├── tests/
│   ├── unit/
│   │   ├── test_project_files.py    # NEW: Unit tests
│   │   └── test_commands_discovery.py  # NEW: Unit tests
│   └── integration/
│       └── test_project_endpoints.py   # NEW: Integration tests
└── pyproject.toml                   # Modified: Added pathspec dependency
```

---

## Appendix C: Configuration Reference

**File**: `service/src/ui_chatter/config.py`

```python
# File listing settings
FILE_LISTING_MAX_DEPTH: int = 10
FILE_LISTING_CACHE_TTL: int = 30  # seconds
FILE_LISTING_DEFAULT_LIMIT: int = 100

# Command discovery settings
COMMAND_CACHE_TTL: int = 60  # seconds
COMMAND_DEFAULT_LIMIT: int = 50
```

**Environment Variable Overrides**:
```bash
# Override in .env or .env.local
FILE_LISTING_CACHE_TTL=60
COMMAND_DEFAULT_LIMIT=100
```

**Usage**:
```python
from .config import settings

lister = ProjectFileLister(
    project_path,
    max_depth=settings.FILE_LISTING_MAX_DEPTH
)
```

---

## Revision History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-01-30 | Initial specification with implementation |
| 1.1 | 2026-01-30 | Added two-layer session architecture clarification after Agent SDK review |

**Version 1.1 Changes:**
- ✅ Added "Two-Layer Session Architecture" section explaining WebSocket vs Agent SDK sessions
- ✅ Updated endpoint descriptions to clarify `session_id` refers to WebSocket session
- ✅ Added security consideration for Agent SDK session persistence
- ✅ Clarified agent commands discovery uses filesystem parsing (not Agent SDK query)
- ✅ Added future enhancement for Agent SDK session management API
- ✅ Added reference to [Agent SDK Sessions Documentation](https://platform.claude.com/docs/en/agent-sdk/sessions)

---

**Document Version**: 1.1
**Status**: DRAFT - Revised with Architecture Clarifications
**Implemented**: 2026-01-30
**Reviewed**: 2026-01-30 (Agent SDK sessions compatibility)
