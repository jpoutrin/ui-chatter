---
tech_spec_id: TS-0001
title: Multi-line Input System
status: DRAFT
decision_ref: null
created: 2026-02-01
last_updated: 2026-02-01
author: ""
tags: [ui, input, ux, keyboard]
---

# TS-0001: Multi-line Input System

## Executive Summary

### Purpose
Implement multi-line text input support in the UI Chatter extension to improve user experience when composing longer messages or messages with formatting.

### Problem Statement
Currently, the message input uses a single-line `<input>` element which:
- Limits visibility when composing longer messages
- Prevents users from entering line breaks for better formatting
- Requires scrolling within the input field for multi-line content
- Lacks standard multi-line editing shortcuts (Shift+Enter)

### Solution Overview
Replace the `<input>` element with a `<textarea>` element that supports:
- Multi-line text entry with automatic height adjustment
- Shift+Enter for new lines
- Enter to send (maintaining current behavior)
- Auto-resizing based on content
- Same styling and UX as current implementation

### Success Criteria
- [ ] Users can enter multi-line messages using Shift+Enter
- [ ] Enter key sends the message (current behavior preserved)
- [ ] Textarea auto-resizes vertically based on content
- [ ] Maximum height limit prevents excessive growth
- [ ] All existing keyboard shortcuts work (arrow keys for history navigation)
- [ ] Visual consistency with current design maintained

---

## Design Overview

### Architecture Diagram

```
┌─────────────────────────────────────────────────┐
│              Side Panel UI                      │
├─────────────────────────────────────────────────┤
│                                                 │
│  Messages Area                                  │
│  ┌───────────────────────────────────────────┐ │
│  │ Message 1                                 │ │
│  │ Message 2                                 │ │
│  └───────────────────────────────────────────┘ │
│                                                 │
│  Input Area                                     │
│  ┌───────────────────────────────────────────┐ │
│  │ [Select] [Textarea - Auto-resize]  [Send] │ │
│  │          Shift+Enter: New line            │ │
│  │          Enter: Send message              │ │
│  │          ↑↓: History navigation           │ │
│  └───────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

### Component Changes

**Current Implementation:**
```html
<input type="text" id="messageInput" placeholder="..."/>
```

**New Implementation:**
```html
<textarea id="messageInput" placeholder="..." rows="1"></textarea>
```

### Key Technical Decisions

1. **Auto-resize Strategy**: Dynamic height adjustment using `scrollHeight`
2. **Keyboard Handling**: Event interception for Enter/Shift+Enter distinction
3. **History Navigation**: Maintain arrow key behavior only when cursor at start/end
4. **Max Height**: CSS-based constraint (e.g., 150px) with scroll for overflow

---

## Implementation Details

### 1. HTML Changes

**File:** `sidepanel.html`

Replace input element:
```html
<!-- Before -->
<input type="text" id="messageInput" placeholder="Click here to start typing..."/>

<!-- After -->
<textarea id="messageInput" placeholder="Click here to start typing..." rows="1"></textarea>
```

### 2. CSS Updates

**File:** `sidepanel.html` (style section)

```css
#messageInput {
  flex: 1;
  padding: 10px 12px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 14px;
  /* New properties */
  resize: none; /* Prevent manual resize */
  overflow-y: auto; /* Show scrollbar when max-height exceeded */
  max-height: 150px; /* Limit vertical growth */
  min-height: 40px; /* Minimum height for single line */
  line-height: 1.5;
  font-family: inherit; /* Match existing font */
}

#messageInput:focus {
  outline: none;
  border-color: #3b82f6;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
}
```

### 3. TypeScript/JavaScript Logic

**File:** `src/sidepanel.ts`

#### Auto-resize Function
```typescript
function autoResizeTextarea(textarea: HTMLTextAreaElement) {
  // Reset height to recalculate
  textarea.style.height = 'auto';

  // Set height based on scroll height
  const newHeight = Math.min(textarea.scrollHeight, 150); // max 150px
  textarea.style.height = newHeight + 'px';
}
```

#### Input Event Listener
```typescript
elements.messageInput.addEventListener('input', () => {
  autoResizeTextarea(elements.messageInput as HTMLTextAreaElement);
});
```

#### Enhanced Enter Key Handling
```typescript
elements.messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    // Shift+Enter: Insert new line (default behavior)
    if (e.shiftKey) {
      // Let default behavior happen
      return;
    }

    // Enter alone: Send message
    e.preventDefault();
    sendMessage();
  }

  // Arrow key history navigation (existing logic)
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    const textarea = e.target as HTMLTextAreaElement;
    const cursorAtStart = textarea.selectionStart === 0;
    const cursorAtEnd = textarea.selectionStart === textarea.value.length;

    // Only navigate history if cursor is at boundary
    if ((e.key === 'ArrowUp' && cursorAtStart) ||
        (e.key === 'ArrowDown' && cursorAtEnd)) {
      e.preventDefault();
      // Existing history navigation code
      navigateHistory(e.key === 'ArrowUp' ? -1 : 1);
    }
  }
});
```

#### Send Message Enhancement
```typescript
function sendMessage() {
  const message = elements.messageInput.value.trim();
  if (!message) return;

  // Send message logic (existing)
  // ...

  // Clear and reset textarea
  elements.messageInput.value = '';
  autoResizeTextarea(elements.messageInput as HTMLTextAreaElement);
}
```

---

## API Specifications

N/A - This is a UI-only enhancement with no API changes.

---

## Data Models

N/A - No data model changes required.

---

## Migration Strategy

### Backward Compatibility
- No breaking changes to existing functionality
- Message format remains the same (line breaks are just `\n` in the string)
- All keyboard shortcuts preserved
- No data migration needed

### Deployment Steps
1. Update HTML template
2. Update CSS styles
3. Update TypeScript event handlers
4. Compile extension (`npm run build`)
5. Reload extension in Chrome (`chrome://extensions/`)
6. Test all keyboard interactions
7. Verify no regression in existing features

### Rollback Plan
If issues arise:
1. Revert to previous commit using `git revert`
2. Recompile extension
3. Reload in Chrome

---

## Testing Strategy

### Unit Tests
N/A - UI interaction testing would be done manually or with integration tests.

### Integration Tests
- [ ] Test Shift+Enter creates new line
- [ ] Test Enter sends message
- [ ] Test auto-resize with increasing content
- [ ] Test max-height constraint activates scrollbar
- [ ] Test arrow key history navigation with cursor at boundaries
- [ ] Test Ctrl+R fuzzy search still works
- [ ] Test input focus after sending message

### Manual Test Cases

#### Test Case 1: Multi-line Input
1. Click in message input
2. Type "Line 1"
3. Press Shift+Enter
4. Type "Line 2"
5. Press Enter
6. **Expected**: Message sent with two lines

#### Test Case 2: Auto-resize
1. Click in message input
2. Type a long message with multiple Shift+Enter line breaks
3. **Expected**: Textarea grows vertically up to max height
4. Continue typing beyond max height
5. **Expected**: Scrollbar appears

#### Test Case 3: History Navigation
1. Send message "test 1"
2. Send message "test 2"
3. Click in input
4. Press ArrowUp
5. **Expected**: "test 2" appears
6. Move cursor to middle of text
7. Press ArrowUp
8. **Expected**: Cursor moves up within text (not history navigation)

#### Test Case 4: Keyboard Shortcuts
1. Press Ctrl+R
2. **Expected**: Fuzzy search modal opens
3. Press Escape
4. Focus returns to input

---

## Security Considerations

### Input Validation
- Continue using existing sanitization for message content
- No new XSS vectors introduced (textarea is same as input for content)
- DOMPurify already handles markdown rendering safely

### Data Privacy
- No changes to data handling
- Messages still processed in-memory only
- No additional data storage

---

## Performance Impact

### Resource Usage
- **Memory**: Negligible increase (textarea vs input)
- **CPU**: Minimal - auto-resize calculation on input events only
- **DOM Updates**: Auto-resize triggers style recalculation (acceptable performance)

### Optimization Strategies
- Consider debouncing auto-resize if performance issues arise
- Use CSS `will-change: height` if animation stutters

---

## Monitoring & Observability

### Metrics to Track
- N/A - No backend changes

### Logging
- Console log errors in auto-resize function
- Log keyboard event handling for debugging

### Alerts
- N/A - Client-side only

---

## Documentation Updates

### User Documentation
Update README.md with:
```markdown
## Message Input Features

- **Multi-line messages**: Press Shift+Enter to add line breaks
- **Send message**: Press Enter to send
- **Navigate history**: Use ↑↓ arrow keys to browse previous messages
- **Search history**: Press Ctrl+R for fuzzy search
```

### Developer Documentation
Update CLAUDE.md or CONTRIBUTING.md with:
```markdown
## Input Component

The message input uses a `<textarea>` with auto-resize functionality:
- Automatically grows with content up to 150px max height
- Shift+Enter for new lines, Enter to send
- Arrow key navigation works only when cursor is at text boundaries
```

---

## Open Questions

- [ ] Should we add a visual indicator for Shift+Enter hint?
- [ ] Should we preserve cursor position when navigating history?
- [ ] Do we want to limit max message length (e.g., 5000 chars)?

---

## References

- [MDN: textarea element](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/textarea)
- [Auto-resize textarea pattern](https://css-tricks.com/the-cleanest-trick-for-autogrowing-textareas/)
- UI Chatter Extension: `sidepanel.html`, `src/sidepanel.ts`

---

## Appendix

### Alternative Approaches Considered

1. **ContentEditable Div**
   - Pros: Full rich text editing, inline formatting
   - Cons: Complex to manage, XSS risks, overkill for simple line breaks
   - Decision: Rejected - too complex for requirements

2. **Fixed Multi-line Textarea**
   - Pros: Simpler implementation
   - Cons: Wastes space for short messages
   - Decision: Rejected - auto-resize provides better UX

3. **Modal for Long Messages**
   - Pros: More screen space for composition
   - Cons: Extra click, interrupts flow
   - Decision: Rejected - inline editing is more intuitive
