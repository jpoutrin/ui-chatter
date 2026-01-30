# TS-0003: Structured LLM Response Protocol for Permission & File Tracking

## Metadata

| Field | Value |
|-------|-------|
| **Tech Spec ID** | TS-0003 |
| **Title** | Structured LLM Response Protocol for Permission & File Tracking |
| **Status** | DRAFT |
| **Author** | |
| **Created** | 2026-01-26 |
| **Last Updated** | 2026-01-26 |
| **Decision Ref** | |
| **Related Docs** | |

---

## Executive Summary

### Problem Statement

The current UI Chatter system has three critical UX issues when Claude Code executes file modifications:

1. **Unreliable file tracking** - Git diff-based tracking misses files from failed permission attempts, shows incomplete data
2. **Poor permission UX** - Multiple permission denials create friction (error → mode switch → retry → error again)
3. **Reactive permission handling** - Permission errors appear AFTER attempts fail, not before

**Impact on Users**:
- Users see inaccurate file lists (missing 1-2 files per interaction in testing)
- Users must retry requests 2-3 times before realizing mode switch is needed
- Conversation flow is interrupted by unexpected errors

### Proposed Solution

Implement a **structured JSON response protocol** using Claude API's tool schema enforcement. Instead of parsing git diffs or text responses with regex, force Claude to use a custom tool that returns structured JSON with:

1. **Look-ahead permission warnings** - Claude analyzes if the NEXT step needs permissions and warns BEFORE attempting
2. **Structured file reporting** - Claude reports ALL file modifications via JSON schema (no parsing ambiguity)
3. **Zero-friction workflow** - User switches modes proactively based on warning, no retries needed

**Key Innovation**: Use a custom tool schema (`response_with_metadata`) that Claude MUST call for every response, ensuring 100% structured data.

### Success Criteria

| Metric | Current | Target | How Measured |
|--------|---------|--------|--------------|
| **File tracking accuracy** | ~70% (misses failed attempts) | 100% | Manual testing with intentional denials |
| **Permission denial frequency** | 2-3 per multi-file task | 0 (replaced by warnings) | User session logs |
| **Time to understand permission needs** | N/A (error-driven) | < 5 seconds | User testing |
| **Mode switches per task** | 1-2 (after errors) | 1 (proactive) | Session analysis |
| **Code complexity** | ~150 lines (git + parsing) | ~60 lines (JSON only) | LOC count |

### Out of Scope

- Permission approval flow (future: user approves specific file changes)
- Line-level diff information (only file paths and change type)
- Multi-user permission inheritance
- Editor auto-detection (hardcoded VS Code for now)

---

## Design Overview

### Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                          Structured Response Protocol                         │
└──────────────────────────────────────────────────────────────────────────────┘

┌─────────────────┐              ┌──────────────────────────────────────────────┐
│ Chrome Extension│              │         FastAPI Server + Backend             │
│                 │              │                                              │
│  ┌───────────┐  │   WebSocket  │  ┌───────────────────────────────────────┐  │
│  │ Side Panel│  │──────────────│─▶│  ClaudeCodeCLIBackend                 │  │
│  │           │  │              │  │                                       │  │
│  │ • Shows   │  │              │  │  1. Define tool schema                │  │
│  │   warnings│  │              │  │  2. Write to temp file                │  │
│  │ • Shows   │  │              │  │  3. Pass --tools to CLI               │  │
│  │   files   │  │◀─────────────│──│  4. Parse tool_use response           │  │
│  │ • Quick   │  │   Structured │  │  5. Extract JSON fields               │  │
│  │   switch  │  │   JSON       │  │                                       │  │
│  └───────────┘  │              │  └────────────┬──────────────────────────┘  │
│                 │              │               │                              │
└─────────────────┘              │               │ --tools schema.json          │
                                 │               │ --output-format stream-json  │
                                 │               ▼                              │
                                 │  ┌───────────────────────────────────────┐  │
                                 │  │  Claude CLI (subprocess)              │  │
                                 │  │                                       │  │
                                 │  │  • Receives tool schema               │  │
                                 │  │  • MUST use response_with_metadata    │  │
                                 │  │  • Returns structured JSON:           │  │
                                 │  │    {                                  │  │
                                 │  │      response_text: "...",            │  │
                                 │  │      next_step_needs_permissions: {}, │  │
                                 │  │      files_modified: []               │  │
                                 │  │    }                                  │  │
                                 │  └───────────────────────────────────────┘  │
                                 └──────────────────────────────────────────────┘
```

### Data Flow

```
1. User request arrives
   │
   ▼
2. Backend builds system prompt:
   - Current permission mode
   - Instructions to use response_with_metadata tool
   - Schema expectations
   │
   ▼
3. Backend creates tool schema JSON:
   {
     name: "response_with_metadata",
     input_schema: {
       response_text: string,
       next_step_needs_permissions: { needed, action, files },
       files_modified: [{ path, change_type }]
     }
   }
   │
   ▼
4. Backend spawns Claude CLI with --tools flag
   │
   ▼
5. Claude analyzes request:
   ├─ In plan mode & needs permissions?
   │  └─ Set next_step_needs_permissions.needed = true
   │
   ├─ In bypass mode & did modify files?
   │  └─ Populate files_modified array
   │
   └─ Always include response_text
   │
   ▼
6. Claude MUST call response_with_metadata tool
   (schema enforcement ensures this)
   │
   ▼
7. Backend parses tool_use JSON:
   ├─ Extract response_text → stream to frontend
   ├─ Extract next_step_needs_permissions → permission_warning message
   └─ Extract files_modified → files_modified message
   │
   ▼
8. Frontend displays structured data:
   ├─ Permission warning → Blue info box with quick-switch button
   └─ Files modified → File list with clickable links
```

### Key Decision: JSON Schema Enforcement vs Text Parsing

| Aspect | Old (Git Diff + Regex) | New (JSON Schema) |
|--------|------------------------|-------------------|
| **Reliability** | Fragile (regex can fail) | Guaranteed by schema |
| **Completeness** | Misses failed attempts | 100% accurate |
| **Parsing complexity** | ~80 lines of regex | ~20 lines JSON extraction |
| **Git dependency** | Required | None |
| **Permission timing** | After errors | Before attempts |
| **User friction** | 2-3 retries typical | 0 retries |
| **Schema validation** | None | Enforced by CLI |

---

## Component Specifications

### 1. Response Tool Schema Definition

#### Schema Structure

```json
{
  "name": "response_with_metadata",
  "description": "Respond to the user with structured metadata about permissions and file changes",
  "input_schema": {
    "type": "object",
    "properties": {
      "response_text": {
        "type": "string",
        "description": "Your natural language response to the user"
      },
      "next_step_needs_permissions": {
        "type": "object",
        "description": "If the next step requires elevated permissions, provide details",
        "properties": {
          "needed": {
            "type": "boolean",
            "description": "Whether the next step needs permissions"
          },
          "action_description": {
            "type": "string",
            "description": "What action needs to be taken (e.g., 'modify Login component')"
          },
          "files_affected": {
            "type": "array",
            "items": {"type": "string"},
            "description": "List of file paths that will be affected"
          }
        },
        "required": ["needed"]
      },
      "files_modified": {
        "type": "array",
        "description": "Files that were actually modified in this response",
        "items": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Relative file path"
            },
            "change_type": {
              "type": "string",
              "enum": ["created", "modified", "deleted"],
              "description": "Type of change made"
            }
          },
          "required": ["path", "change_type"]
        }
      }
    },
    "required": ["response_text"]
  }
}
```

#### System Prompt Instructions

```
CRITICAL: You MUST use the 'response_with_metadata' tool for EVERY response.

Current permission mode: {permission_mode}

STRUCTURED RESPONSE PROTOCOL:
1. Always call 'response_with_metadata' with:
   - response_text: Your natural language response
   - next_step_needs_permissions: If next step needs elevated permissions
   - files_modified: Files you actually modified (if any)

2. PERMISSION AWARENESS:
   [In plan/default mode]
   - DO NOT attempt file/command tools that will be denied
   - Instead, analyze and set next_step_needs_permissions.needed = true
   - Provide clear action_description and files_affected list
   - Explain what the next step requires

   [In bypass mode]
   - You can freely modify files
   - After using Edit/Write tools, populate files_modified array

3. FILE TRACKING:
   - After successfully using Edit/Write/NotebookEdit tools
   - Add each file to files_modified array
   - Include accurate path and change_type
   - Be complete - list ALL files you changed
```

### 2. Backend Implementation

#### File: `service/src/ui_chatter/backends/claude_cli.py`

**Changes Required**:

1. **Define tool schema in `__init__`**:
   ```python
   def __init__(self, project_path: str, session_id: str, permission_mode: str = "bypassPermissions", **kwargs):
       super().__init__(project_path)
       self.claude_session_id = session_id
       self.permission_mode = permission_mode

       # Define response structure tool
       self._response_tool_schema = {
           "name": "response_with_metadata",
           "description": "Respond with structured metadata",
           "input_schema": { ... }  # Full schema from above
       }
   ```

2. **Write schema to temp file and pass to CLI**:
   ```python
   # In handle_chat() method
   import json
   import tempfile

   # Write tool schema to temp file
   tools_file = tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False)
   json.dump([self._response_tool_schema], tools_file)
   tools_file.close()

   # Add --tools flag to CLI command
   cmd = [
       "claude",
       "-p",
       "--session-id" if is_first_message else "--resume",
       self.claude_session_id,
       "--permission-mode", self.permission_mode,
       "--system-prompt", system_prompt,
       "--tools", tools_file.name,  # ← NEW: Provide tool schema
       "--output-format", "stream-json",
       "--verbose",
   ]
   ```

3. **Parse tool_use response**:
   ```python
   # In message parsing loop (around line 177)
   elif content_block.get("type") == "tool_use":
       tool_name = content_block.get("name")
       tool_input = content_block.get("input", {})

       if tool_name == "response_with_metadata":
           # Extract response text
           response_text = tool_input.get("response_text", "")
           if response_text:
               yield {
                   "type": "response_chunk",
                   "content": response_text,
                   "done": False,
               }

           # Extract permission warning
           next_step = tool_input.get("next_step_needs_permissions", {})
           if next_step.get("needed", False):
               yield {
                   "type": "permission_warning",
                   "action_description": next_step.get("action_description", ""),
                   "files_affected": next_step.get("files_affected", []),
                   "is_look_ahead": True,
               }

           # Extract file modifications
           files_modified = tool_input.get("files_modified", [])
           if files_modified:
               yield {
                   "type": "files_modified",
                   "files": files_modified,
                   "summary": f"Modified {len(files_modified)} file{'s' if len(files_modified) != 1 else ''}",
                   "session_id": self.claude_session_id,
               }
   ```

**Code Removal**:
- Remove `_capture_git_state()` method (~40 lines)
- Remove git subprocess calls (~30 lines)
- Remove `_files_before` / `_files_after` tracking (~10 lines)
- **Total reduction**: ~80 lines

### 3. Message Models

#### File: `service/src/ui_chatter/models/messages.py`

**New Message Type**:

```python
class PermissionWarningMessage(BaseModel):
    """Look-ahead warning that next step needs permissions."""

    type: Literal["permission_warning"] = "permission_warning"
    action_description: str = Field(..., description="What action is needed")
    files_affected: List[str] = Field(
        default_factory=list,
        description="Files that will be affected"
    )
    is_look_ahead: bool = Field(
        True,
        description="This is a future action, not current"
    )
```

**Existing Message Type (Keep)**:

```python
class FilesModifiedMessage(BaseModel):
    """List of files modified during Claude's execution."""

    type: Literal["files_modified"] = "files_modified"
    files: List[FileModification] = Field(..., description="List of modified files")
    summary: Optional[str] = Field(None, description="Summary of modifications")
    session_id: str = Field(..., description="Claude CLI session ID")

class FileModification(BaseModel):
    """Information about a single file modification."""

    path: str = Field(..., description="Relative file path")
    change_type: Literal["created", "modified", "deleted"] = Field(
        ...,
        description="Type of change"
    )
    lines_added: Optional[int] = Field(None, description="Lines added")
    lines_removed: Optional[int] = Field(None, description="Lines removed")
```

### 4. Frontend Implementation

#### File: `poc/extension/sidepanel.js`

**Message Handler Update**:

```javascript
function handleServerMessage(message) {
  if (message.type === 'permission_warning') {
    displayPermissionWarning(message);
  } else if (message.type === 'files_modified') {
    displayModifiedFiles(message);
  } else if (message.type === 'response_chunk') {
    if (message.done) {
      addMessage('status', 'Response complete');
    } else {
      appendToLastMessage(message.content);
    }
  } else if (message.type === 'status') {
    addMessage('status', message.detail || message.status);
  } else if (message.type === 'error') {
    addMessage('error', `Error: ${message.message}`);
  }
}
```

**Display Permission Warning**:

```javascript
function displayPermissionWarning(message) {
  const container = document.createElement('div');
  container.className = 'permission-notice';
  container.innerHTML = `
    <div class="notice-header">
      <span class="icon">💡</span>
      <strong>Next Step Needs Permissions</strong>
    </div>
    <div class="notice-content">
      <p class="action">${escapeHtml(message.action_description)}</p>
      ${message.files_affected && message.files_affected.length > 0 ? `
        <div class="files-list">
          <strong>Files to be modified:</strong>
          <ul>
            ${message.files_affected.map(f => `<li><code>${escapeHtml(f)}</code></li>`).join('')}
          </ul>
        </div>
      ` : ''}
    </div>
    ${permissionMode === 'plan' || permissionMode === 'default' ? `
      <div class="notice-actions">
        <button class="btn btn-sm btn-primary quick-switch-btn">
          Switch to Bypass Mode
        </button>
        <span class="hint">or press Shift+Tab</span>
      </div>
    ` : ''}
  `;

  elements.messages.appendChild(container);

  // Add click handler for quick switch
  const switchBtn = container.querySelector('.quick-switch-btn');
  if (switchBtn) {
    switchBtn.addEventListener('click', () => {
      togglePermissionMode();
    });
  }

  container.scrollIntoView({ behavior: 'smooth' });
}
```

**Display Modified Files** (keep existing implementation):

```javascript
function displayModifiedFiles(message) {
  if (!message.files || message.files.length === 0) return;

  const container = document.createElement('div');
  container.className = 'files-modified';
  container.innerHTML = `
    <div class="files-header">
      <span class="icon">📝</span>
      <strong>Files Modified</strong>
      ${message.summary ? `<span class="summary">${escapeHtml(message.summary)}</span>` : ''}
    </div>
    <ul class="file-list">
      ${message.files.map(file => `
        <li class="file-item" data-path="${escapeHtml(file.path)}">
          <span class="change-type change-type-${file.change_type}">${file.change_type}</span>
          <a href="#" class="file-link" data-path="${escapeHtml(file.path)}">${escapeHtml(file.path)}</a>
        </li>
      `).join('')}
    </ul>
  `;

  elements.messages.appendChild(container);

  // Add click handlers
  container.querySelectorAll('.file-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      openFileInEditor(e.target.dataset.path);
    });
  });

  container.scrollIntoView({ behavior: 'smooth' });
}
```

#### File: `poc/extension/sidepanel.html`

**CSS Styles** (add to existing styles):

```css
/* Permission Notice (Look-Ahead Warning) */
.permission-notice {
  background: #e3f2fd;
  border: 2px solid #64b5f6;
  border-left: 4px solid #2196f3;
  border-radius: 8px;
  padding: 16px;
  margin: 12px 0;
  max-width: 100%;
}

.notice-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  font-size: 15px;
  font-weight: 600;
  color: #1565c0;
}

.notice-header .icon {
  font-size: 18px;
}

.notice-content {
  margin-bottom: 12px;
  color: #333;
  line-height: 1.5;
}

.notice-content .action {
  margin: 0 0 8px 0;
  font-weight: 500;
}

.notice-content .files-list {
  background: #f5f5f5;
  padding: 8px 12px;
  border-radius: 4px;
  margin-top: 8px;
}

.notice-content .files-list ul {
  list-style: none;
  padding-left: 0;
  margin: 8px 0 0 0;
}

.notice-content .files-list code {
  background: #e0e0e0;
  padding: 2px 6px;
  border-radius: 3px;
  font-family: 'Courier New', monospace;
  font-size: 12px;
}

.notice-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-top: 12px;
  border-top: 1px solid #bbdefb;
}

.btn-sm {
  padding: 6px 14px;
  font-size: 13px;
}

.notice-actions .hint {
  font-size: 12px;
  color: #666;
  font-style: italic;
}

/* Files Modified Styling (keep existing) */
.files-modified {
  background: #e7f5ff;
  border: 2px solid #4c9aff;
  border-radius: 8px;
  padding: 16px;
  margin: 12px 0;
  max-width: 100%;
}

/* ... rest of existing CSS ... */
```

---

## API Specifications

### Tool Schema API

**Endpoint**: File passed via `--tools` flag to Claude CLI

**Format**: JSON array of tool definitions

**Example**:
```json
[
  {
    "name": "response_with_metadata",
    "description": "Respond to the user with structured metadata about permissions and file changes",
    "input_schema": {
      "type": "object",
      "properties": {
        "response_text": {"type": "string"},
        "next_step_needs_permissions": {
          "type": "object",
          "properties": {
            "needed": {"type": "boolean"},
            "action_description": {"type": "string"},
            "files_affected": {"type": "array", "items": {"type": "string"}}
          },
          "required": ["needed"]
        },
        "files_modified": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {"type": "string"},
              "change_type": {"type": "string", "enum": ["created", "modified", "deleted"]}
            },
            "required": ["path", "change_type"]
          }
        }
      },
      "required": ["response_text"]
    }
  }
]
```

### WebSocket Message Schemas

#### Permission Warning Message

```json
{
  "type": "permission_warning",
  "action_description": "Modify the login button text in the Login component",
  "files_affected": ["src/components/Login.tsx"],
  "is_look_ahead": true
}
```

#### Files Modified Message

```json
{
  "type": "files_modified",
  "files": [
    {
      "path": "src/components/Login.tsx",
      "change_type": "modified",
      "lines_added": null,
      "lines_removed": null
    },
    {
      "path": "tests/Login.test.tsx",
      "change_type": "created",
      "lines_added": null,
      "lines_removed": null
    }
  ],
  "summary": "Modified 2 files",
  "session_id": "abc-123-def"
}
```

---

## Example User Flows

### Flow 1: Look-Ahead Permission Warning

**Context**: User in plan mode (restrictive)

```
User: "I want to change the login button text"

Claude Response (via tool):
{
  "response_text": "I can see the login button is defined in src/components/Login.tsx. The current text is 'Log In'.",
  "next_step_needs_permissions": {
    "needed": true,
    "action_description": "Modify the login button text in the Login component",
    "files_affected": ["src/components/Login.tsx"]
  }
}

Frontend Displays:
1. Text: "I can see the login button is defined in..."
2. Blue notice box: "Next Step Needs Permissions"
   - Action: Modify the login button text
   - Files: src/components/Login.tsx
   - Button: "Switch to Bypass Mode"

User: Clicks button → Mode switches to bypass

User: "Go ahead and change it to 'Sign In'"

Claude Response (via tool):
{
  "response_text": "I've updated the login button text from 'Log In' to 'Sign In'.",
  "files_modified": [
    {
      "path": "src/components/Login.tsx",
      "change_type": "modified"
    }
  ]
}

Frontend Displays:
1. Text: "I've updated the login button text..."
2. Blue file box: "Files Modified"
   - [modified] src/components/Login.tsx (clickable)
```

### Flow 2: No Permissions Needed (Research)

**Context**: User in plan mode

```
User: "What files handle routing?"

Claude Response (via tool):
{
  "response_text": "Routing is handled in src/App.tsx using React Router. The main routes are defined there...",
  "next_step_needs_permissions": {
    "needed": false
  }
}

Frontend Displays:
1. Text: "Routing is handled in src/App.tsx..."
2. No warning box (needed = false)
```

### Flow 3: Multiple Files Modified

**Context**: User in bypass mode

```
User: "Add a contact form"

Claude Response (via tool):
{
  "response_text": "I've created a contact form with validation and submission handling.",
  "files_modified": [
    {
      "path": "src/components/ContactForm.tsx",
      "change_type": "created"
    },
    {
      "path": "src/utils/validation.ts",
      "change_type": "created"
    },
    {
      "path": "src/pages/Contact.tsx",
      "change_type": "modified"
    },
    {
      "path": "tests/ContactForm.test.tsx",
      "change_type": "created"
    }
  ]
}

Frontend Displays:
1. Text: "I've created a contact form..."
2. Blue file box with 4 clickable links:
   - [created] src/components/ContactForm.tsx
   - [created] src/utils/validation.ts
   - [modified] src/pages/Contact.tsx
   - [created] tests/ContactForm.test.tsx
```

---

## Security Considerations

| Concern | Mitigation |
|---------|------------|
| **Tool schema injection** | Schema defined in backend code, not user input |
| **File path traversal** | Frontend validates paths before opening, no `../` allowed |
| **Permission bypass** | Backend enforces mode, frontend can only request switch |
| **Schema tampering** | Temp file created with secure permissions, deleted after use |

---

## Testing Plan

### Unit Tests

**File**: `service/tests/test_backends.py`

```python
def test_tool_schema_generation():
    """Verify tool schema is valid JSON."""
    backend = ClaudeCodeCLIBackend(...)
    schema = backend._response_tool_schema

    assert schema["name"] == "response_with_metadata"
    assert "input_schema" in schema
    assert "response_text" in schema["input_schema"]["properties"]

def test_parse_tool_use_response():
    """Test parsing tool_use with structured data."""
    backend = ClaudeCodeCLIBackend(...)

    tool_use_data = {
        "type": "tool_use",
        "name": "response_with_metadata",
        "input": {
            "response_text": "Test response",
            "next_step_needs_permissions": {
                "needed": true,
                "action_description": "Modify file",
                "files_affected": ["src/test.py"]
            },
            "files_modified": []
        }
    }

    messages = list(backend._parse_tool_use(tool_use_data))

    assert any(m["type"] == "permission_warning" for m in messages)
    assert any(m["type"] == "response_chunk" for m in messages)

def test_files_modified_extraction():
    """Test extraction of files_modified array."""
    backend = ClaudeCodeCLIBackend(...)

    tool_use_data = {
        "type": "tool_use",
        "name": "response_with_metadata",
        "input": {
            "response_text": "Done",
            "files_modified": [
                {"path": "src/test.py", "change_type": "modified"},
                {"path": "tests/test_test.py", "change_type": "created"}
            ]
        }
    }

    messages = list(backend._parse_tool_use(tool_use_data))

    files_msg = next(m for m in messages if m["type"] == "files_modified")
    assert len(files_msg["files"]) == 2
    assert files_msg["files"][0]["path"] == "src/test.py"
    assert files_msg["files"][1]["change_type"] == "created"
```

### Integration Tests

| # | Scenario | Steps | Expected Result |
|---|----------|-------|-----------------|
| 1 | Look-ahead warning (plan mode) | Request file change in plan mode | Permission warning appears with file list |
| 2 | Quick-switch button | Click quick-switch in warning | Mode changes, warning persists |
| 3 | File tracking (bypass mode) | Modify files in bypass mode | All files appear in list |
| 4 | No warning (research) | Ask question in plan mode | No permission warning shown |
| 5 | Multiple files | Create feature with 3+ files | All files tracked accurately |
| 6 | Failed tool use | Claude can't find file | No files_modified, clear error |

### Manual Testing Checklist

- [ ] Tool schema is valid JSON and parseable by Claude CLI
- [ ] Claude CLI accepts `--tools` flag with temp file path
- [ ] Claude uses `response_with_metadata` tool (not raw text)
- [ ] Permission warnings appear BEFORE tool use attempts
- [ ] File list matches actual modifications (100% accuracy)
- [ ] Quick-switch button works (mode changes immediately)
- [ ] File links open in VS Code correctly
- [ ] No git errors in logs
- [ ] Works in non-git directories
- [ ] UI is responsive with long file paths

---

## Implementation Plan

### Phase 1: Backend - Tool Schema (2-3 hours)

- [ ] Define `_response_tool_schema` in `ClaudeCodeCLIBackend.__init__`
- [ ] Implement temp file creation for schema
- [ ] Add `--tools` flag to CLI command
- [ ] Update system prompt with tool usage instructions
- [ ] Test schema is accepted by Claude CLI

### Phase 2: Backend - JSON Parsing (2-3 hours)

- [ ] Parse `tool_use` messages for `response_with_metadata`
- [ ] Extract `response_text` and stream it
- [ ] Extract `next_step_needs_permissions` and yield warning message
- [ ] Extract `files_modified` and yield files message
- [ ] Remove all git diff logic (~80 lines)
- [ ] Test with mock tool_use data

### Phase 3: Frontend - Permission Notices (2-3 hours)

- [ ] Add `displayPermissionWarning()` function
- [ ] Add quick-switch button handler
- [ ] Add CSS styling for `.permission-notice`
- [ ] Update `handleServerMessage()` dispatcher
- [ ] Test warning display and button click

### Phase 4: Frontend - File Display (1-2 hours)

- [ ] Verify existing `displayModifiedFiles()` works with new data
- [ ] Test file link clicking
- [ ] Test editor opening (VS Code)
- [ ] Polish UI styling

### Phase 5: Testing & Validation (3-4 hours)

- [ ] End-to-end test: plan mode → warning → switch → modify → files
- [ ] Test with 0 files, 1 file, 10+ files
- [ ] Test with research queries (no warnings)
- [ ] Verify 100% file tracking accuracy
- [ ] Performance testing (latency, memory)
- [ ] Bug fixes

**Total Estimate**: 10-15 hours of implementation work

---

## Rollback Plan

If JSON schema enforcement doesn't work or causes issues:

1. **Immediate Rollback**:
   - Remove `--tools` flag from CLI command
   - Restore git diff logic from git history
   - Deploy previous backend version
   - Frontend continues to work (handles both message types)

2. **Partial Rollback**:
   - Keep tool schema for file tracking
   - Remove look-ahead permission warnings
   - Fall back to reactive permission denials

3. **Testing Before Production**:
   - Validate on staging with 10+ test scenarios
   - A/B test with 5 internal users for 1 week
   - Monitor error rates and user feedback

---

## Open Questions

1. **Does Claude CLI support `--tools` flag?**
   - Need to verify CLI version and flag availability
   - May need to use alternative approach (e.g., tool definitions in system prompt)

2. **How strictly does Claude follow schema?**
   - Will Claude always use the tool?
   - What if Claude tries to skip it for simple responses?
   - Need testing to validate enforcement

3. **What if tool schema is malformed?**
   - Error handling for JSON syntax errors
   - Fallback behavior if schema is rejected

4. **Performance impact of temp file I/O?**
   - Measure latency impact of file write/read
   - Consider caching schema file if reused

**Action**: Validate CLI capabilities and run POC before full implementation.

---

## Appendix

### References

- [Claude API Tool Use Documentation](https://docs.anthropic.com/claude/docs/tool-use)
- [Claude CLI Documentation](https://claude.ai/docs/cli)
- [JSON Schema Specification](https://json-schema.org/)

### Glossary

| Term | Definition |
|------|------------|
| **Tool Schema** | JSON definition of a custom tool that Claude can call |
| **Look-ahead Warning** | Permission warning that appears before attempting restricted actions |
| **Structured Response** | Response that uses JSON schema instead of free text |
| **Permission Mode** | Setting that controls what actions Claude can perform (plan, bypass, etc.) |

### Related Documents

- [TS-0001: ACP Browser Integration POC](./TS-0001-acp-browser-integration-poc.md)
- [TS-0002: Agent SDK MVP Implementation](./TS-0002-agent-sdk-mvp-implementation.md)

---

## Status History

| Date | Status | Notes |
|------|--------|-------|
| 2026-01-26 | DRAFT | Initial specification created |
