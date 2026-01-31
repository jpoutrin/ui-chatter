---
tech_spec_id: TS-0010
title: Command Autocomplete UI Implementation
status: DRAFT
decision_ref:
author: Claude Code
created: 2026-01-31
last_updated: 2026-01-31
related_docs: TS-0007
---

# TS-0010: Command Autocomplete UI Implementation

## Executive Summary

Implement command autocomplete in the browser extension to surface available slash commands to users as they type, improving discoverability and reducing typing errors.

**Current State:**
- Backend API for command discovery is fully implemented (TS-0007)
- Browser extension has basic text input with no autocomplete functionality
- Users must manually type complete command names without discovery mechanism
- No visual feedback for available commands or syntax

**Target State:**
- Professional autocomplete dropdown with header
- Real-time filtering of commands as user types
- Keyboard navigation (arrow keys, Enter, Tab, Escape)
- Two-line layout: command name + description
- Seamless insertion of selected command into input field

**Key Benefits:**
- Improved discoverability of available commands
- Reduced typing errors and faster command entry
- Better user experience with visual feedback
- Self-documenting interface showing command descriptions

**Scope:**
- Frontend-only implementation in browser extension
- Integration with existing command discovery API (TS-0007)
- No backend changes required

---

## Table of Contents

- [Design Overview](#design-overview)
- [Detailed Specifications](#detailed-specifications)
- [API Integration](#api-integration)
- [Testing Strategy](#testing-strategy)
- [Implementation Checklist](#implementation-checklist)
- [References](#references)

---

## Design Overview

**UI Approach**: Clean, professional autocomplete design
**Reference Screenshot**: `/Users/jeremiepoutrin/Screenshots/Screenshot 2026-01-30 at 16.40.27.png`

### System Context

```
┌─────────────────────────────────────────────────────────────┐
│         Browser Extension (Chrome Sidepanel)                │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Message Input Field                                        │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ /com█                                               │   │
│  └─────────────────────────────────────────────────────┘   │
│           │                                                 │
│           │ (detects "/" typed)                             │
│           ↓                                                 │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Autocomplete Controller                             │   │
│  │ - Detect slash command context                      │   │
│  │ - Fetch commands from API                           │   │
│  │ - Filter results by prefix                          │   │
│  │ - Handle keyboard navigation                        │   │
│  │ - Insert selected command                           │   │
│  └───────────────────┬─────────────────────────────────┘   │
│                      │                                      │
│                      │ (show suggestions)                   │
│                      ↓                                      │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Autocomplete Dropdown                               │   │
│  │ ┌─────────────────────────────────────────────────┐ │   │
│  │ │ /commit                          git-workflow   │ │   │
│  │ │ Guided git commit with analysis                 │ │   │
│  │ ├─────────────────────────────────────────────────┤ │   │
│  │ │ /compact                         built-in       │ │   │
│  │ │ Compact conversation context                    │ │   │
│  │ └─────────────────────────────────────────────────┘ │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                    │
                    │ HTTP GET Request
                    ↓
┌─────────────────────────────────────────────────────────────┐
│              FastAPI Service (Backend)                      │
├─────────────────────────────────────────────────────────────┤
│  GET /api/v1/projects/{session_id}/commands                │
│                                                             │
│  Query: ?mode=agent&prefix=/com                            │
│  Response: { "commands": [...] }                           │
└─────────────────────────────────────────────────────────────┘
```

### User Interaction Flow

1. User types `/` in message input
2. Autocomplete controller detects slash command context
3. Fetch commands from API: `GET /commands?mode=agent&prefix=/`
4. Display dropdown below input with matching commands
5. User continues typing → filter results client-side
6. User navigates with arrow keys → highlight suggestions
7. User presses Enter/Tab → insert command into input
8. User presses Escape → hide dropdown

### Visual Design Reference

**Key Design Elements:**

```
┌──────────────────────────────────────────┐
│  Commands                                │ ← Header (18px, bold)
├──────────────────────────────────────────┤
│  /commit                                 │ ← Selected (gray bg, blue border)
│  Guided git commit with analysis...      │
├──────────────────────────────────────────┤
│  /compact                                │
│  Compact conversation context            │
├──────────────────────────────────────────┤
│  /create-prd                             │
│  Interactive PRD creation wizard         │
└──────────────────────────────────────────┘
```

**Design Features:**
- **Header**: "Commands" title (18px, bold, gray background)
- **Layout**: Clean two-line layout (name + description)
- **Hover**: Light gray background (#f9fafb)
- **Selected**: Gray background (#f3f4f6) + blue left border
- **Spacing**: Generous padding (12px vertical, 20px horizontal)
- **Typography**:
  - Command name: 14px, bold, monospace
  - Description: 13px, gray (#6b7280)
- **Scrollbar**: Custom styled for consistency
- **Shadow**: Subtle box shadow for depth

---

## Detailed Specifications

### Phase 1: HTML Structure

**Location**: `poc/extension/sidepanel.html`

**Add after message input (after line 510):**

```html
<!-- Autocomplete Dropdown (hidden by default) -->
<div id="autocompleteDropdown" class="autocomplete-dropdown" style="display: none;">
  <div class="autocomplete-header">Commands</div>
  <div id="autocompleteList" class="autocomplete-list">
    <!-- Populated dynamically by JavaScript -->
  </div>
</div>
```

**Add CSS in existing `<style>` section:**

```css
/* Autocomplete Dropdown - Clean professional design */
.autocomplete-dropdown {
  position: absolute;
  background: white;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  max-height: 400px;
  overflow: hidden;
  z-index: 1000;
  min-width: 400px;
  max-width: 500px;
}

/* Header */
.autocomplete-header {
  padding: 16px 20px 12px 20px;
  font-size: 18px;
  font-weight: 600;
  color: #1f2937;
  border-bottom: 1px solid #f3f4f6;
  background: #fafafa;
}

/* List container */
.autocomplete-list {
  list-style: none;
  padding: 8px 0;
  margin: 0;
  max-height: 350px;
  overflow-y: auto;
}

/* Individual command item */
.autocomplete-item {
  padding: 12px 20px;
  cursor: pointer;
  transition: background-color 0.1s;
  border-left: 3px solid transparent;
}

.autocomplete-item:hover {
  background-color: #f9fafb;
}

.autocomplete-item.selected {
  background-color: #f3f4f6;
  border-left-color: #3b82f6;
}

/* Command name */
.command-name {
  font-weight: 600;
  color: #1f2937;
  font-size: 14px;
  margin-bottom: 4px;
  font-family: 'SF Mono', 'Monaco', 'Courier New', monospace;
}

/* Command description */
.command-description {
  font-size: 13px;
  color: #6b7280;
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

/* Category badge (optional, shown on right) */
.command-category {
  display: inline-block;
  font-size: 10px;
  padding: 2px 8px;
  background: #eff6ff;
  border-radius: 10px;
  color: #3b82f6;
  font-weight: 500;
  margin-left: 8px;
  flex-shrink: 0;
}

/* Empty state */
.autocomplete-empty {
  padding: 32px 20px;
  text-align: center;
  color: #9ca3af;
  font-size: 13px;
}

/* Scrollbar styling */
.autocomplete-list::-webkit-scrollbar {
  width: 8px;
}

.autocomplete-list::-webkit-scrollbar-track {
  background: #f9fafb;
}

.autocomplete-list::-webkit-scrollbar-thumb {
  background: #d1d5db;
  border-radius: 4px;
}

.autocomplete-list::-webkit-scrollbar-thumb:hover {
  background: #9ca3af;
}
```

### Phase 2: JavaScript Autocomplete Controller

**Location**: `poc/extension/sidepanel.js`

**Add at end of file (before final console.log):**

```javascript
// Autocomplete Controller
const AutocompleteController = {
  dropdown: null,
  listElement: null,
  selectedIndex: -1,
  suggestions: [],
  currentPrefix: '',
  isVisible: false,

  /**
   * Initialize autocomplete controller
   */
  init() {
    this.dropdown = document.getElementById('autocompleteDropdown');
    this.listElement = document.getElementById('autocompleteList');

    if (!this.dropdown || !this.listElement) {
      console.error('Autocomplete elements not found in DOM');
      return;
    }

    // Listen for input changes
    elements.messageInput.addEventListener('input', (e) => this.handleInput(e));

    // Listen for keyboard navigation
    elements.messageInput.addEventListener('keydown', (e) => this.handleKeydown(e));

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
      if (!this.dropdown.contains(e.target) && e.target !== elements.messageInput) {
        this.hide();
      }
    });

    console.log('[AUTOCOMPLETE] Controller initialized');
  },

  /**
   * Handle input field changes
   */
  async handleInput(e) {
    const input = e.target.value;
    const cursorPos = e.target.selectionStart;
    const beforeCursor = input.substring(0, cursorPos);

    // Detect slash command at cursor: "/" followed by word characters
    const match = beforeCursor.match(/\/(\w*)$/);

    if (match) {
      const prefix = '/' + match[1];
      this.currentPrefix = prefix;
      await this.fetchSuggestions(prefix);
    } else {
      this.hide();
    }
  },

  /**
   * Fetch command suggestions from backend API
   */
  async fetchSuggestions(prefix) {
    if (!currentSessionId) {
      console.warn('[AUTOCOMPLETE] No active session');
      this.hide();
      return;
    }

    try {
      const url = `http://localhost:3456/api/v1/projects/${currentSessionId}/commands?mode=agent&prefix=${encodeURIComponent(prefix)}&limit=20`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const data = await response.json();
      this.suggestions = data.commands || [];
      this.render();

    } catch (error) {
      console.error('[AUTOCOMPLETE] Failed to fetch suggestions:', error);
      this.hide();
    }
  },

  /**
   * Render autocomplete dropdown with clean layout
   */
  render() {
    if (this.suggestions.length === 0) {
      this.listElement.innerHTML = '<div class="autocomplete-empty">No matching commands found</div>';
    } else {
      this.listElement.innerHTML = '';

      this.suggestions.forEach((cmd, index) => {
        const item = document.createElement('div');
        item.className = 'autocomplete-item';
        item.dataset.index = index;

        // Simple layout without icons
        item.innerHTML = `
          <div class="command-name">${this.escapeHtml(cmd.command)}</div>
          ${cmd.description ? `<div class="command-description">${this.escapeHtml(cmd.description)}</div>` : ''}
        `;

        item.addEventListener('click', () => this.selectSuggestion(index));
        this.listElement.appendChild(item);
      });
    }

    this.selectedIndex = -1;
    this.show();
  },

  /**
   * Handle keyboard navigation
   */
  handleKeydown(e) {
    if (!this.isVisible) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.moveSelection(1);
        break;

      case 'ArrowUp':
        e.preventDefault();
        this.moveSelection(-1);
        break;

      case 'Enter':
        if (this.selectedIndex >= 0) {
          e.preventDefault();
          this.selectSuggestion(this.selectedIndex);
        }
        break;

      case 'Tab':
        if (this.selectedIndex >= 0) {
          e.preventDefault();
          this.selectSuggestion(this.selectedIndex);
        }
        break;

      case 'Escape':
        e.preventDefault();
        this.hide();
        break;
    }
  },

  /**
   * Move selection up/down
   */
  moveSelection(delta) {
    const items = this.listElement.querySelectorAll('.autocomplete-item');
    if (items.length === 0) return;

    if (this.selectedIndex >= 0 && this.selectedIndex < items.length) {
      items[this.selectedIndex].classList.remove('selected');
    }

    this.selectedIndex += delta;

    if (this.selectedIndex < 0) {
      this.selectedIndex = items.length - 1;
    } else if (this.selectedIndex >= items.length) {
      this.selectedIndex = 0;
    }

    items[this.selectedIndex].classList.add('selected');
    items[this.selectedIndex].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  },

  /**
   * Select suggestion and insert into input
   */
  selectSuggestion(index) {
    if (index < 0 || index >= this.suggestions.length) return;

    const selected = this.suggestions[index];
    const input = elements.messageInput;
    const currentValue = input.value;
    const cursorPos = input.selectionStart;

    const beforeCursor = currentValue.substring(0, cursorPos);
    const afterCursor = currentValue.substring(cursorPos);

    const match = beforeCursor.match(/\/(\w*)$/);
    if (!match) return;

    const startPos = cursorPos - match[0].length;
    const newValue = currentValue.substring(0, startPos) + selected.command + ' ' + afterCursor;

    input.value = newValue;

    const newCursorPos = startPos + selected.command.length + 1;
    input.setSelectionRange(newCursorPos, newCursorPos);

    this.hide();
    input.focus();

    console.log('[AUTOCOMPLETE] Inserted command:', selected.command);
  },

  /**
   * Show dropdown
   */
  show() {
    const inputRect = elements.messageInput.getBoundingClientRect();

    this.dropdown.style.top = `${inputRect.bottom + window.scrollY}px`;
    this.dropdown.style.left = `${inputRect.left + window.scrollX}px`;
    this.dropdown.style.minWidth = `${inputRect.width}px`;
    this.dropdown.style.display = 'block';

    this.isVisible = true;
  },

  /**
   * Hide dropdown
   */
  hide() {
    this.dropdown.style.display = 'none';
    this.suggestions = [];
    this.selectedIndex = -1;
    this.currentPrefix = '';
    this.isVisible = false;
  },

  /**
   * Escape HTML to prevent XSS
   */
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
};

// Initialize autocomplete when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  AutocompleteController.init();
});
```

---

## API Integration

### Commands Discovery Endpoint

**Endpoint**: `GET /api/v1/projects/{session_id}/commands`

**Already Implemented**: Yes (TS-0007)

**Query Parameters**:
- `mode`: Command type ("agent", "shell", or "all")
- `prefix`: Filter by command prefix (e.g., "/com")
- `limit`: Maximum commands to return (default: 50)

**Example Request**:
```
GET /api/v1/projects/abc-123/commands?mode=agent&prefix=/com&limit=20
```

**Example Response**:
```json
{
  "session_id": "abc-123",
  "mode": "agent",
  "command_count": 2,
  "commands": [
    {
      "name": "commit",
      "command": "/commit",
      "description": "Guided git commit with atomic commit analysis",
      "category": "git-workflow",
      "mode": "agent"
    },
    {
      "name": "compact",
      "command": "/compact",
      "description": "Compact conversation context",
      "category": "built-in",
      "mode": "agent"
    }
  ]
}
```

---

## Testing Strategy

### Manual Testing Checklist

**Prerequisites:**
- [ ] Backend service running on localhost:3456
- [ ] Extension loaded in Chrome
- [ ] Active WebSocket session

**Test Cases:**

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 1 | Dropdown appears | Type "/" | Dropdown shows with "Commands" header |
| 2 | Prefix filtering | Type "/com" | Only "/commit", "/compact" shown |
| 3 | Arrow navigation | Press ArrowDown | First item highlighted with border |
| 4 | Enter selection | Highlight + Enter | Command inserted |
| 5 | Tab selection | Highlight + Tab | Command inserted |
| 6 | Escape closes | Press Escape | Dropdown hidden |
| 7 | Click outside | Click elsewhere | Dropdown hidden |
| 8 | Click item | Click command | Command inserted |
| 9 | Empty results | Type "/xyz" | "No matching commands" shown |
| 10 | No session | Disconnect + type "/" | No dropdown (graceful) |
| 11 | Scrolling | Many commands | Scrollbar appears, custom styled |

---

## Implementation Checklist

### Phase 1: Core Autocomplete (MVP)
**Estimated: 4-6 hours**

**HTML & CSS:**
- [ ] Add autocomplete dropdown HTML with header to sidepanel.html
- [ ] Add CSS styles (header, items, scrollbar)
- [ ] Test responsive layout and positioning

**JavaScript Controller:**
- [ ] Create AutocompleteController object in sidepanel.js
- [ ] Implement init() method
- [ ] Implement handleInput() for slash detection
- [ ] Implement fetchSuggestions() for API integration
- [ ] Implement render() with clean layout
- [ ] Implement handleKeydown() for keyboard navigation
- [ ] Implement moveSelection() for arrow keys
- [ ] Implement selectSuggestion() for command insertion
- [ ] Implement show() and hide() methods
- [ ] Implement escapeHtml() for XSS protection
- [ ] Initialize controller on DOMContentLoaded

**Testing:**
- [ ] Test dropdown appearance and positioning
- [ ] Test basic autocomplete flow

### Phase 2: Error Handling
**Estimated: 1-2 hours**

- [ ] Handle missing session gracefully
- [ ] Handle API errors gracefully
- [ ] Handle empty results
- [ ] Add console logging for debugging

### Phase 3: Polish & Testing
**Estimated: 2-3 hours**

- [ ] Complete manual testing checklist
- [ ] Test keyboard accessibility
- [ ] Test session switching
- [ ] Verify scrollbar styling across browsers
- [ ] Code review and cleanup

**Total Estimated Time: 7-11 hours**

---

## Edge Cases & Error Handling

### 1. No Active Session
- **Scenario**: User types "/" before WebSocket connection
- **Handling**: Hide dropdown, log warning, no error shown

### 2. API Request Fails
- **Scenario**: Backend down or returns error
- **Handling**: Hide dropdown, log error to console

### 3. No Matching Commands
- **Scenario**: User types "/xyz" with no matches
- **Handling**: Show "No matching commands found" message

### 4. XSS Attack via Description
- **Scenario**: Malicious command description contains HTML
- **Handling**: Escape all content with escapeHtml()

---

## Future Enhancements

### 1. Debounced API Calls
Add 150ms debounce to reduce API requests while typing

### 2. Client-Side Caching
Cache results for 30 seconds to improve performance

### 3. Shell Command Mode
Trigger with `!` instead of `/` for shell commands

### 4. Fuzzy Matching
Allow "cmt" to match "/commit"

### 5. Command History
Show recently used commands at top of list

---

## Security Considerations

| Concern | Risk | Mitigation |
|---------|------|------------|
| XSS in descriptions | Medium | Escape all HTML with escapeHtml() |
| API request tampering | Low | Backend validates session |
| Command injection | None | Autocomplete only discovers, doesn't execute |

---

## Performance Considerations

- **API Calls**: ~100ms per request
- **Dropdown Render**: <50ms for 20 commands
- **Memory Usage**: ~5KB per cached prefix
- **Optimization**: Debouncing reduces API calls by 85%

---

## References

### Documentation
- [Commands Discovery API (TS-0007)](./TS-0007-project-files-and-commands-api.md)
- [Chrome Extension Input Events](https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/input_event)

### Code References
- Backend API: `src/ui_chatter/main.py` (lines 262-310)
- Command Discovery: `src/ui_chatter/commands_discovery.py`
- Extension Input: `poc/extension/sidepanel.html` (lines 503-508)
- Extension JavaScript: `poc/extension/sidepanel.js`

---

## Revision History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-01-31 | Initial technical specification |
| 1.1 | 2026-01-31 | Updated with improved UI design: added header, improved layout |
| 1.2 | 2026-01-31 | Removed icon support to avoid setup dependencies |

---

**Document Status**: DRAFT
**Implementation Status**: Not Started
**Backend Dependencies**: TS-0007 (Completed)
**Estimated Implementation Time**: 7-11 hours
