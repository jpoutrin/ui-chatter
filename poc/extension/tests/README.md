# UI Chatter Extension Test Suite

Comprehensive test harness for the UI Chatter Chrome Extension.

## Overview

This test suite provides:
- **Behavioral tests** for session management and tab switching logic
- **Chrome API mocking** for realistic extension testing
- **Regression tests** for critical bugs (tab switching history loss)
- **Test utilities** for common testing scenarios

**Note**: These tests focus on behavioral correctness and regression prevention rather than line-by-line code coverage. They test the critical message handling logic in isolation to ensure session persistence and history loading work correctly across tab switches.

## Setup

```bash
# Install dependencies
npm install

# Or using yarn
yarn install
```

## Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode (auto-rerun on changes)
npm run test:watch

# Run with coverage report
npm run test:coverage

# Run specific test file
npm test -- tests/background.test.js
```

## Test Structure

```
tests/
├── setup.js              # Jest configuration and Chrome API mocks
├── background.test.js    # Tests for background.js (tab management)
├── sidepanel.test.js     # Tests for sidepanel.js (UI logic)
└── README.md            # This file
```

## Test Utilities

The `tests/setup.js` file provides several utilities accessible via `global.testUtils`:

### `createMockConnection(overrides)`
Creates a mock tab connection object:
```javascript
const connection = testUtils.createMockConnection({
  sessionId: 'custom-session',
  sdkSessionId: 'custom-sdk-session'
});
```

### `createMockTab(overrides)`
Creates a mock Chrome tab object:
```javascript
const tab = testUtils.createMockTab({
  id: 2,
  url: 'https://example.com',
  title: 'Example Page'
});
```

### `simulateTabSwitch(tabId, pageUrl)`
Simulates a tab activation event:
```javascript
testUtils.simulateTabSwitch(1, 'https://example.com');
```

### `simulateMessage(message)`
Simulates a message from background to sidepanel:
```javascript
testUtils.simulateMessage({
  type: 'tab_switched',
  tabId: 1,
  pageUrl: 'https://example.com'
});
```

### `flushPromises()`
Waits for all pending promises to resolve:
```javascript
await testUtils.flushPromises();
```

## Chrome API Mocking

All Chrome APIs are automatically mocked in `setup.js`:

- `chrome.runtime.sendMessage` - Returns success by default
- `chrome.tabs.get/query` - Returns mock tab data
- `chrome.storage.local.get/set` - Simulates local storage
- `chrome.sidePanel.open` - Mock for side panel API
- `WebSocket` - Mock WebSocket implementation

## Test Philosophy

These tests prioritize **behavioral correctness** and **regression prevention** over code coverage metrics. The tests verify that:

1. Session registration messages are properly handled
2. Tab-to-session mappings persist across tab switches
3. Chat history loads correctly when switching back to tabs
4. SDK session IDs are maintained throughout the session lifecycle

This approach catches the types of bugs that cause user-facing issues (like lost chat history) without requiring brittle tests that break on UI changes.

For code coverage analysis:
```bash
npm run test:coverage
open coverage/index.html
```

## Writing Tests

### Example Test Structure

```javascript
import { describe, test, expect, beforeEach } from '@jest/globals';

describe('Feature Name', () => {
  beforeEach(() => {
    // Setup before each test
    jest.clearAllMocks();
  });

  test('should do something specific', () => {
    // Arrange
    const input = 'test data';

    // Act
    const result = functionUnderTest(input);

    // Assert
    expect(result).toBe('expected output');
  });
});
```

### Testing Tab Switching

```javascript
test('should preserve session when switching tabs', () => {
  // Create connection with session info
  const connection = testUtils.createMockConnection({
    sessionId: 'session-123',
    sdkSessionId: 'sdk-456'
  });

  // Verify session info is preserved
  expect(connection.sessionId).toBe('session-123');
  expect(connection.sdkSessionId).toBe('sdk-456');
});
```

### Testing Message Handlers

```javascript
test('should handle message correctly', () => {
  const message = {
    type: 'register_tab_session',
    tabId: 1,
    sessionId: 'session-123'
  };

  const sendResponse = jest.fn();
  messageHandler(message, {}, sendResponse);

  expect(sendResponse).toHaveBeenCalledWith({ success: true });
});
```

## Regression Tests

The test suite includes regression tests for known bugs:

### Tab Switching History Loss (Fixed)
- **File**: `tests/background.test.js` and `tests/sidepanel.test.js`
- **Test**: `should maintain session info across tab switches (bug fix verification)`
- **What it tests**: Verifies that `register_tab_session` handler properly stores session info

## CI/CD Integration

Add to your CI pipeline:

```yaml
# .github/workflows/test-extension.yml
name: Extension Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: cd poc/extension && npm install
      - run: cd poc/extension && npm test
      - run: cd poc/extension && npm run test:coverage
```

## Best Practices

1. **One assertion per test** when possible (makes failures clearer)
2. **Use descriptive test names** that explain what is being tested
3. **Follow AAA pattern**: Arrange, Act, Assert
4. **Mock external dependencies** (Chrome APIs, WebSocket, fetch)
5. **Test edge cases** (null values, empty arrays, error conditions)
6. **Maintain regression tests** for fixed bugs
7. **Keep tests fast** (avoid unnecessary timeouts or delays)

## Troubleshooting

### Tests not running
- Ensure Node.js 18+ is installed
- Run `npm install` to install dependencies
- Check for syntax errors in test files

### Mock not working
- Verify `tests/setup.js` is loaded
- Check `setupFilesAfterEnv` in package.json
- Clear Jest cache: `npx jest --clearCache`

### Coverage too low
- Run `npm run test:coverage` to see uncovered lines
- Add tests for uncovered branches
- Focus on critical paths first

## Future Improvements

- [ ] E2E tests with Playwright
- [ ] Visual regression tests
- [ ] Performance benchmarks
- [ ] Integration tests with live server
- [ ] TypeScript migration with type-safe tests
