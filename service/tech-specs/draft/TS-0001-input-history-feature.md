---
tech_spec_id: TS-0001
title: Input History Feature for UI Chatter Browser Extension
status: DRAFT
decision_ref:
author: Jeremie Poutrin
created: 2026-02-01
last_updated: 2026-02-01
related_prd:
---

# TS-0001: Input History Feature for UI Chatter Browser Extension

## Executive Summary

This specification describes the implementation of an input history feature for the UI Chatter browser extension, enabling users to quickly access and search through their previously sent messages. The feature provides two interaction modes: (1) arrow key navigation (↑/↓) for quick recall of recent messages, and (2) fuzzy search (Ctrl+R) for finding specific messages across the full history. Each browser tab maintains its own isolated history stored in chrome.storage.local with an in-memory cache for instant access. The design follows existing patterns in the extension (AutocompleteController, permission modal) and uses Fuse.js for client-side fuzzy search to avoid additional server dependencies.

---

## Table of Contents

- [Design Overview](#design-overview)
- [Detailed Specifications](#detailed-specifications)
- [Data Model](#data-model)
- [API Specification](#api-specification)
- [Security Implementation](#security-implementation)
- [Performance Considerations](#performance-considerations)
- [Testing Strategy](#testing-strategy)
- [Deployment & Operations](#deployment--operations)
- [Dependencies](#dependencies)
- [Implementation Checklist](#implementation-checklist)
- [References](#references)

---

## Design Overview

### Architecture Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                      UI Layer (sidepanel.html)                │
│                                                                │
│  ┌─────────────────┐      ┌──────────────────────────────┐   │
│  │  Input Field    │      │   History Search Modal       │   │
│  │  (messageInput) │      │   ┌────────────────────┐     │   │
│  │      ↑ ↓       │      │   │ Search Input       │     │   │
│  └────────┬────────┘      │   └────────┬───────────┘     │   │
│           │               │            │                 │   │
│           │               │   ┌────────▼───────────┐     │   │
│           │               │   │ Fuse.js Search    │     │   │
│           │               │   └────────┬───────────┘     │   │
│           │               │            │                 │   │
│           │               │   ┌────────▼───────────┐     │   │
│           │               │   │ Results List      │     │   │
│           │               │   │ (with highlights) │     │   │
│           │               │   └────────────────────┘     │   │
│           │               └──────────────────────────────┘   │
└───────────┼──────────────────────────────────────────────────┘
            │
            ▼
┌──────────────────────────────────────────────────────────────┐
│              InputHistoryController (sidepanel.ts)            │
│                                                                │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ In-Memory History Store                              │    │
│  │ tabInputHistories: Record<tabId, TabInputHistory>    │    │
│  │                                                       │    │
│  │ TabInputHistory {                                    │    │
│  │   entries: InputHistoryEntry[]                       │    │
│  │   currentPosition: number                            │    │
│  │   draftMessage: string                               │    │
│  │   maxSize: 50                                        │    │
│  │ }                                                     │    │
│  └──────────────────────────────────────────────────────┘    │
│                           │                                    │
│                           ▼                                    │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ Keyboard Event Handlers                              │    │
│  │ • Arrow Up/Down → handleArrowNavigation()            │    │
│  │ • Ctrl+R → openSearchModal()                         │    │
│  │ • Modal shortcuts (Enter, Esc, ↑↓)                  │    │
│  └──────────────────────────────────────────────────────┘    │
│                           │                                    │
└───────────────────────────┼────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────┐
│                   Chrome Storage API                          │
│                                                                │
│  chrome.storage.local {                                       │
│    "input_history_<tabId>": InputHistoryEntry[]              │
│  }                                                             │
│                                                                │
│  • Persistent storage across panel close/reopen              │
│  • Per-tab isolation                                          │
│  • Max 50 entries per tab                                     │
└──────────────────────────────────────────────────────────────┘
```

### Component Overview

**InputHistoryController**: Central controller managing all history operations
- Maintains per-tab in-memory history cache
- Handles arrow key navigation state machine
- Manages fuzzy search modal lifecycle
- Syncs with chrome.storage.local for persistence

**Arrow Key Navigation**: Stateful navigation through history
- Preserves current draft when entering navigation mode
- Cycles through history entries (newest first)
- Returns to draft when navigating past oldest entry

**Fuzzy Search Modal**: Full-text search interface using Fuse.js
- Real-time fuzzy matching as user types
- Match highlighting in results
- Keyboard navigation (↑↓ Enter Esc)
- Falls back to showing all history when search is empty

**Storage Layer**: Hybrid in-memory + persistent storage
- In-memory for instant arrow key responses (no async delays)
- chrome.storage.local for persistence across sessions
- Per-tab isolation using storage key pattern: `input_history_${tabId}`

### Data Flow

#### Sending a Message
1. User types message in `messageInput` field
2. User presses Enter or clicks Send button
3. `sendMessage()` function called → message sent to backend
4. `InputHistoryController.addToHistory(message)` called
5. Message deduplicated (skip if same as last entry)
6. Entry added to in-memory `tabInputHistories[currentTabId]`
7. Debounced save to `chrome.storage.local` with key `input_history_${currentTabId}`
8. Max size enforced (keep newest 50 entries)

#### Arrow Key Navigation
1. User presses Arrow Up (input not focused on autocomplete)
2. Check: Autocomplete visible? → Yes: autocomplete handles it, exit
3. Check: Currently navigating? → No: Save current input as `draftMessage`, set position=0
4. Load history entry at current position into `messageInput.value`
5. Increment/decrement position on subsequent arrow presses
6. On Arrow Down past position=0: Restore `draftMessage`, exit navigation mode
7. On any character typed: Restore `draftMessage`, exit navigation mode

#### Fuzzy Search
1. User presses Ctrl+R (input not disabled from streaming)
2. `openSearchModal()` creates Fuse.js instance from current tab's history
3. Modal displayed, search input auto-focused
4. User types query → `performSearch(query)` called on each keystroke
5. Fuse.js searches history entries, returns matches with scores and match indices
6. `renderResults()` displays results with highlighted matching text
7. User navigates with ↑↓, selects with Enter
8. Selected message fills `messageInput`, modal closes

#### Tab Switching
1. Browser tab switches (Chrome fires `chrome.tabs.onActivated`)
2. `handleTabSwitch(message)` called in sidepanel
3. `InputHistoryController.setCurrentTab(newTabId)` switches active history
4. If history not in memory: Load from `chrome.storage.local.get('input_history_${newTabId}')`
5. History now ready for arrow navigation and search

---

## Detailed Specifications

### Component 1: InputHistoryController

**Responsibility**
Manages all input history state, storage, navigation, and search functionality for the current tab.

**Technology Stack**
- Language: TypeScript 5.3.3
- Runtime: Chrome Extension context (side panel)
- Storage: chrome.storage.local API
- Search: Fuse.js 7.0.0

**Key Interfaces**
```typescript
interface InputHistoryController {
  // State
  histories: Record<number, TabInputHistory>;
  currentTabId: number | null;
  navigationMode: boolean;
  draftMessage: string;
  historyPosition: number;

  // Modal state
  modal: HTMLElement | null;
  searchInput: HTMLInputElement | null;
  resultsContainer: HTMLElement | null;
  selectedIndex: number;
  fuse: any; // Fuse instance

  // Methods
  init(): void;
  setCurrentTab(tabId: number): void;
  addToHistory(message: string): Promise<void>;
  loadHistory(tabId: number): Promise<void>;
  saveHistory(tabId: number): Promise<void>;
  handleArrowNavigation(direction: 'up' | 'down'): void;
  openSearchModal(): void;
  closeSearchModal(): void;
  performSearch(query: string): void;
  selectResult(index: number): void;
  renderResults(results: InputHistoryEntry[]): void;
}
```

**Implementation Notes**
- Follow existing pattern from `AutocompleteController` (lines 897-1144 in sidepanel.ts)
- Use singleton object pattern (not a class) for consistency with codebase
- Debounce `saveHistory()` to max 1 call per second per tab
- Clear navigation state on any user input (typing resets to draft)

---

### Component 2: Arrow Key Event Handler

**Responsibility**
Intercepts arrow key presses on the message input field and delegates to InputHistoryController, with conflict resolution for existing autocomplete feature.

**Technology Stack**
- Language: TypeScript
- Event: `keydown` on `document` or `messageInput` element

**Key Interfaces**
```typescript
Input: KeyboardEvent (ArrowUp or ArrowDown)
Output: void (modifies messageInput.value, updates internal state)

Priority Chain:
1. If autocomplete dropdown is visible → autocomplete handles it
2. Else if input field has focus → history navigation handles it
3. Else → do nothing
```

**Implementation Notes**
- Add listener after existing `keypress` listener (around line 1233 in sidepanel.ts)
- Check `autocompleteController.isVisible` before handling
- Prevent default behavior to avoid cursor movement in input
- Exit navigation mode if user starts typing (not an arrow key)

---

### Component 3: Fuzzy Search Modal

**Responsibility**
Provides a visual interface for searching through history using fuzzy matching, with keyboard shortcuts for efficient interaction.

**Technology Stack**
- Language: TypeScript + HTML + CSS
- Search Library: Fuse.js 7.0.0
- UI Pattern: Modal overlay (similar to permission modal)

**Key Interfaces**
```typescript
Input: Ctrl+R keyboard shortcut
Output: Selected history message inserted into messageInput

Modal Lifecycle:
openSearchModal() → Initialize Fuse → Focus search input → User types
  → performSearch() → renderResults() → User navigates with ↑↓
  → User presses Enter → selectResult() → Close modal

Keyboard Shortcuts:
- Ctrl+R: Open modal
- ↑↓: Navigate results
- Enter: Select result
- Esc: Close modal
```

**Implementation Notes**
- Modal HTML structure added after permission modal in sidepanel.html (~line 1034)
- CSS reuses patterns from `.permission-modal` and `.autocomplete-list`
- Fuse.js configuration:
  ```typescript
  new Fuse(history.entries, {
    keys: ['message'],
    threshold: 0.3,  // 0=exact, 1=match anything
    includeScore: true,
    includeMatches: true  // For highlighting
  })
  ```
- Match highlighting using `<mark>` tags with `.history-match-highlight` class
- Close modal on tab switch or when streaming starts (input disabled)

---

## Data Model

### Entity Definitions

#### Entity 1: InputHistoryEntry

| Field | Type | Description | Constraints |
|-------|------|-------------|-------------|
| message | string | User's sent message | NOT NULL, 1-10000 chars |
| timestamp | number | Unix timestamp (ms) | NOT NULL, > 0 |

#### Entity 2: TabInputHistory

| Field | Type | Description | Constraints |
|-------|------|-------------|-------------|
| entries | InputHistoryEntry[] | Array of history entries | Max 50 entries |
| maxSize | number | Maximum entries to keep | Default: 50 |
| currentPosition | number | Navigation position | -1 (not navigating) or 0-49 |
| draftMessage | string | Saved input before navigation | 0-10000 chars |

### Entity Relationships

```
TabInputHistory ──────1:N────── InputHistoryEntry
                                (entries array)
```

### Storage Schema

**chrome.storage.local Keys**:
```
input_history_<tabId>: InputHistoryEntry[]

Example:
{
  "input_history_12345": [
    { "message": "Fix the button styling", "timestamp": 1738368000000 },
    { "message": "What is the API endpoint?", "timestamp": 1738367800000 },
    ...
  ]
}
```

**In-Memory Structure**:
```typescript
const tabInputHistories: Record<number, TabInputHistory> = {
  12345: {
    entries: [
      { message: "Fix the button styling", timestamp: 1738368000000 },
      { message: "What is the API endpoint?", timestamp: 1738367800000 }
    ],
    maxSize: 50,
    currentPosition: -1,  // -1 = not navigating
    draftMessage: ""
  }
};
```

### Migration Strategy

Not applicable - this is a new feature with no existing data to migrate. On first load, each tab starts with empty history.

---

## API Specification

### Authentication

Not applicable - this is a client-side browser extension feature with no server API calls. All operations use local Chrome APIs.

### Chrome Storage API Usage

#### Save History
```typescript
chrome.storage.local.set({
  [`input_history_${tabId}`]: entries
}, () => {
  if (chrome.runtime.lastError) {
    console.error('Failed to save history:', chrome.runtime.lastError);
  }
});
```

#### Load History
```typescript
chrome.storage.local.get([`input_history_${tabId}`], (result) => {
  const entries = result[`input_history_${tabId}`] || [];
  // Populate in-memory store
});
```

#### Clear History on Tab Close
```typescript
// In background.ts, chrome.tabs.onRemoved listener
chrome.storage.local.remove(`input_history_${tabId}`);
```

### Internal Function APIs

#### addToHistory(message: string): Promise<void>

**Description**: Add a message to the current tab's history

**Parameters**:
- `message`: User's sent message (trimmed)

**Behavior**:
1. Get current tab's history from in-memory store
2. Check if message is duplicate of last entry → Skip if duplicate
3. Add `{ message, timestamp: Date.now() }` to entries array
4. Enforce max size: If entries.length > 50, remove oldest (shift)
5. Save to chrome.storage.local (debounced)

**Returns**: Promise that resolves when saved

---

#### handleArrowNavigation(direction: 'up' | 'down'): void

**Description**: Navigate through history with arrow keys

**Parameters**:
- `direction`: 'up' (older) or 'down' (newer)

**State Machine**:
```
State: Not navigating (position=-1)
  ↓ [Arrow Up]
  → Save messageInput.value as draftMessage
  → Set position=0
  → Load entries[0] into input

State: Navigating (position=0..N)
  ↓ [Arrow Up]
  → Increment position (if not at end)
  → Load entries[position] into input

  ↓ [Arrow Down]
  → Decrement position
  → If position >= 0: Load entries[position] into input
  → If position < 0: Restore draftMessage, exit navigation mode
```

**Returns**: void (side effects: modifies messageInput.value)

---

#### performSearch(query: string): void

**Description**: Search history using Fuse.js and render results

**Parameters**:
- `query`: Search string from modal input

**Behavior**:
1. If query is empty: Show all history (newest first)
2. Else: Use Fuse.js to search entries
3. Extract results and match indices for highlighting
4. Call renderResults() with results

**Returns**: void (side effects: updates modal DOM)

---

## Security Implementation

### Authentication Mechanism

Not applicable - no server authentication required.

### Authorization Model

Not applicable - all operations are local to the user's browser.

### Data Protection

- **Encryption at rest**: No - chrome.storage.local is not encrypted by Chrome, but is isolated per extension and protected by OS-level browser profile encryption
- **Encryption in transit**: Not applicable - no network transmission
- **Sensitive data handling**:
  - History contains user's chat messages, which may include sensitive information
  - Storage is scoped to the extension (not accessible by web pages)
  - Consider adding "Clear History" feature in future for privacy

### Compliance Requirements

- **No PII collection**: History is stored locally, never transmitted to servers
- **User control**: User can clear browser data to remove history
- **Transparency**: Document feature in extension description

### XSS Prevention

**Risk**: User's history messages rendered in search modal could contain XSS payloads if not sanitized.

**Mitigation**:
- Use `textContent` instead of `innerHTML` when inserting history messages
- For match highlighting, use DOM methods or trusted sanitizer:
  ```typescript
  // Safe approach
  const mark = document.createElement('mark');
  mark.className = 'history-match-highlight';
  mark.textContent = matchedText;
  ```

---

## Performance Considerations

### Targets

| Metric | Target | Measurement |
|--------|--------|-------------|
| Arrow key response time | < 16ms (1 frame) | Manual testing |
| Search results render time | < 100ms | Performance.now() |
| Storage save operation | Non-blocking (async) | No UI freeze |
| Memory footprint per tab | < 50KB | DevTools memory profiler |

### Caching Strategy

| Cache | TTL | Invalidation |
|-------|-----|--------------|
| In-memory history | Session lifetime | Tab close or panel reload |
| chrome.storage.local | Persistent | Manual clear or tab close |

### Optimization Approach

- **In-memory cache**: Primary store is in-memory for instant access; chrome.storage.local is backup only
- **Debounced saves**: Max 1 save per second per tab to avoid excessive storage writes
- **Lazy loading**: Only load history for current tab; defer loading for background tabs until switched
- **Efficient deduplication**: Check only last entry (O(1)) instead of full history scan
- **Fuse.js configuration**: Use threshold 0.3 for balanced performance vs accuracy

### Monitoring Metrics

- **Storage quota usage**: Track chrome.storage.local.getBytesInUse() to ensure we don't hit 10MB limit
- **History size per tab**: Log average and max entry counts
- **Search performance**: Measure time to render results for 50-entry history

---

## Testing Strategy

### Unit Tests

**Coverage Target**: Not applicable (extension uses vanilla JS/TS without unit test infrastructure)

**Manual Validation**:
- Test `addToHistory()` with duplicate messages
- Test navigation state machine transitions
- Test Fuse.js search with various query types
- Test storage save/load with tab ID variations

### Integration Tests

**Scenarios**:

1. **Happy path: Arrow navigation**
   - Send 3 messages
   - Press Arrow Up → verify last message shown
   - Press Arrow Up → verify second-to-last shown
   - Press Arrow Down → verify last message shown
   - Press Arrow Down → verify draft restored

2. **Happy path: Fuzzy search**
   - Send messages: "Fix button", "Update header", "Test form"
   - Press Ctrl+R
   - Type "button" → verify "Fix button" highlighted
   - Press Enter → verify input filled with "Fix button"

3. **Error handling: Empty history**
   - New tab with no messages sent
   - Press Arrow Up → no change
   - Press Ctrl+R → empty state shown

4. **Edge case: Tab switching**
   - Tab A: Send "Message A"
   - Tab B: Send "Message B"
   - Switch to Tab A → press Arrow Up → verify "Message A" shown

5. **Edge case: Autocomplete priority**
   - Type "/" → autocomplete opens
   - Press Arrow Down → autocomplete navigates (not history)
   - Close autocomplete → press Arrow Up → history navigates

6. **Edge case: Modal during streaming**
   - Send message → wait for streaming to start (input disabled)
   - Press Ctrl+R → modal should not open
   - Wait for streaming to finish → press Ctrl+R → modal opens

### Load Testing

Not applicable for client-side feature. Chrome enforces storage quota limits (10MB total), which we're far below with ~20KB per tab.

---

## Deployment & Operations

### Deployment Process

1. **Build**: Run `npx tsc` to compile TypeScript to JavaScript
2. **Validate**: Check compiled files in `dist/` directory
3. **Package**: Zip extension directory (or use Chrome's "Pack extension" tool)
4. **Test locally**: Load unpacked extension in Chrome → test all scenarios
5. **Release**: Upload to Chrome Web Store (if distributed) or deploy internally

### Configuration Management

No environment variables or configuration needed - feature is fully client-side with hardcoded defaults.

### Monitoring & Alerting

**Client-side error logging**:
```typescript
// Log storage errors
chrome.storage.local.set(..., () => {
  if (chrome.runtime.lastError) {
    console.error('[InputHistory] Storage error:', chrome.runtime.lastError);
  }
});
```

**Manual monitoring**:
- Check Chrome DevTools console for errors during testing
- Use `chrome://extensions` to view extension errors

### Rollback Procedure

1. **Identify issue**: User reports or dev testing reveals bug
2. **Disable feature**: Comment out `InputHistoryController.init()` call
3. **Rebuild**: Run `npx tsc` to recompile
4. **Reload extension**: Chrome extensions can be reloaded without reinstalling
5. **Verify**: Test that feature is disabled and no errors occur

### Runbooks

Not applicable for browser extension - no server infrastructure to manage.

---

## Dependencies

### External Services

None - fully client-side feature.

### Internal Components

| Component | Purpose | Owner |
|-----------|---------|-------|
| AutocompleteController | Conflict resolution for arrow keys | Extension team |
| sendMessage() function | Hook point for adding history | Extension team |
| handleTabSwitch() function | Hook point for loading tab history | Extension team |

### Third-Party Libraries

| Library | Version | Purpose | License |
|---------|---------|---------|---------|
| Fuse.js | 7.0.0 | Client-side fuzzy search | Apache 2.0 |
| TypeScript | 5.3.3 | Type safety and compilation | Apache 2.0 |

**Fuse.js Integration**:
- Download minified bundle from https://cdn.jsdelivr.net/npm/fuse.js@7.0.0/dist/fuse.min.js
- Save to `/Users/jeremiepoutrin/projects/github/jpoutrin/ui-chatter/poc/extension/libs/fuse.min.js`
- Include in `sidepanel.html`: `<script src="libs/fuse.min.js"></script>`
- Size: ~15KB minified, ~9KB gzipped

---

## Implementation Checklist

### Phase 1: Foundation (Core Storage)

**Target**: Day 1

- [ ] Add `InputHistoryEntry` and `TabInputHistory` interfaces to `src/types.ts`
- [ ] Create `InputHistoryController` skeleton in `src/sidepanel.ts`
- [ ] Implement `init()`, `loadHistory()`, `saveHistory()` methods
- [ ] Hook `addToHistory()` into `sendMessage()` function
- [ ] Hook `setCurrentTab()` into `handleTabSwitch()` function
- [ ] Test with console.log: Verify messages save to chrome.storage.local
- [ ] Test persistence: Close panel, reopen, verify history loads

### Phase 2: Arrow Key Navigation

**Target**: Day 2

- [ ] Implement `handleArrowNavigation()` state machine
- [ ] Add keydown event listener to `messageInput` (or document)
- [ ] Add priority check: If autocomplete visible, skip history handling
- [ ] Add draft preservation logic (save on first Arrow Up)
- [ ] Test navigation: Up/Down arrows cycle through history
- [ ] Test draft restore: Arrow Down past newest restores draft
- [ ] Test typing during navigation: Resets to draft

### Phase 3: Fuzzy Search Modal (UI + Search)

**Target**: Day 3-4

- [ ] Download Fuse.js 7.0.0 minified from CDN
- [ ] Save to `libs/fuse.min.js` in extension directory
- [ ] Add `<script src="libs/fuse.min.js"></script>` to `sidepanel.html` head
- [ ] Add modal HTML structure to `sidepanel.html` (after permission modal)
- [ ] Add CSS styles for modal (reuse permission modal patterns)
- [ ] Implement `openSearchModal()` and `closeSearchModal()` methods
- [ ] Add Ctrl+R keyboard shortcut listener (document-level keydown)
- [ ] Implement `performSearch()` with Fuse.js integration
- [ ] Implement `renderResults()` with match highlighting using `<mark>` tags
- [ ] Add modal keyboard shortcuts (↑↓ for navigation, Enter for select, Esc for close)
- [ ] Test search: Type query, verify fuzzy matches appear
- [ ] Test selection: Navigate with arrows, press Enter, verify input filled

### Phase 4: Polish & Edge Cases

**Target**: Day 5

- [ ] Add timestamp formatting (relative time: "2 hours ago", "Yesterday")
- [ ] Add empty state handling: Show "No history yet" in modal
- [ ] Add no results state: Show "No matching history" when search returns empty
- [ ] Enforce max size (50 entries): Remove oldest when adding 51st entry
- [ ] Add deduplication: Skip consecutive duplicates in `addToHistory()`
- [ ] Add XSS prevention: Use `textContent` for message rendering
- [ ] Add focus management: Modal steals focus, returns to input on close
- [ ] Add conflict resolution: Disable Ctrl+R when input is disabled (streaming)
- [ ] Add tab switch handling: Close modal on tab switch
- [ ] Test edge cases: Empty history, very long messages, special characters

### Phase 5: Integration Testing & Cleanup

**Target**: Day 6

- [ ] Test with autocomplete: Verify arrow keys work correctly with priority
- [ ] Test with permission modal: Verify no conflicts (both use modal patterns)
- [ ] Test tab switching: Verify each tab has isolated history
- [ ] Test persistence: Send messages, close/reopen panel, verify history intact
- [ ] Test storage cleanup: Close tab, verify history removed from storage (optional)
- [ ] Run TypeScript compiler: `npx tsc --noEmit` → verify no errors
- [ ] Manual QA session: Test all 7 verification scenarios from plan
- [ ] Code review: Check for memory leaks, unnecessary re-renders
- [ ] Performance check: Measure search performance with 50 entries
- [ ] Documentation: Update extension README with feature description

### Phase 6: Deployment (Optional)

**Target**: Day 7

- [ ] Compile TypeScript: `npx tsc`
- [ ] Test in clean browser profile: Load unpacked extension, verify all features
- [ ] Create release notes: Document new feature and usage
- [ ] Deploy to Chrome Web Store (if applicable)

---

## References

### Related Documents

- Plan File: `/Users/jeremiepoutrin/.claude/plans/zany-napping-pebble.md`
- Exploration Results: Agent a622cc1 (UI exploration), Agent a17de06 (storage exploration)

### Codebase Files

- Main UI logic: `/Users/jeremiepoutrin/projects/github/jpoutrin/ui-chatter/poc/extension/src/sidepanel.ts`
- HTML structure: `/Users/jeremiepoutrin/projects/github/jpoutrin/ui-chatter/poc/extension/sidepanel.html`
- Type definitions: `/Users/jeremiepoutrin/projects/github/jpoutrin/ui-chatter/poc/extension/src/types.ts`
- Background worker: `/Users/jeremiepoutrin/projects/github/jpoutrin/ui-chatter/poc/extension/src/background.ts`

### External Documentation

- Fuse.js Documentation: https://fusejs.io/
- Chrome Storage API: https://developer.chrome.com/docs/extensions/reference/storage/
- Chrome Extension Manifest V3: https://developer.chrome.com/docs/extensions/mv3/intro/

### Key Patterns to Follow

- **AutocompleteController** (sidepanel.ts:897-1144): Singleton object pattern, keyboard handling, dropdown rendering
- **Permission Modal** (sidepanel.html:999-1034): Modal overlay pattern, keyboard shortcuts (Enter/Esc)
- **Storage Pattern** (settings.ts): chrome.storage.local.get/set with error handling

### Appendix: User Preferences Confirmed

During planning phase, user confirmed:
- ✅ Per-tab history (not global)
- ✅ 50 entry limit
- ✅ Deduplication of consecutive duplicates
- ✅ Ctrl+R keyboard shortcut for fuzzy search
