/**
 * Jest setup file for Chrome Extension testing
 * Mocks Chrome APIs and provides test utilities
 */

import { jest, beforeEach } from '@jest/globals';

// Mock Chrome APIs
global.chrome = {
  runtime: {
    sendMessage: jest.fn((message, callback) => {
      if (callback) callback({ success: true });
      return Promise.resolve({ success: true });
    }),
    onMessage: {
      addListener: jest.fn(),
      removeListener: jest.fn()
    },
    lastError: null
  },
  tabs: {
    get: jest.fn((tabId, callback) => {
      const tab = { id: tabId, url: 'https://example.com', title: 'Test Page' };
      if (callback) callback(tab);
      return Promise.resolve(tab);
    }),
    query: jest.fn((queryInfo, callback) => {
      const tabs = [{ id: 1, url: 'https://example.com', active: true }];
      if (callback) callback(tabs);
      return Promise.resolve(tabs);
    }),
    onActivated: {
      addListener: jest.fn(),
      removeListener: jest.fn()
    },
    onUpdated: {
      addListener: jest.fn(),
      removeListener: jest.fn()
    }
  },
  storage: {
    local: {
      get: jest.fn((keys, callback) => {
        const result = {};
        if (callback) callback(result);
        return Promise.resolve(result);
      }),
      set: jest.fn((items, callback) => {
        if (callback) callback();
        return Promise.resolve();
      })
    }
  },
  sidePanel: {
    open: jest.fn(),
    setOptions: jest.fn()
  }
};

// Mock WebSocket
global.WebSocket = class WebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = WebSocket.CONNECTING;
    this.CONNECTING = 0;
    this.OPEN = 1;
    this.CLOSING = 2;
    this.CLOSED = 3;

    // Simulate connection after a tick
    setTimeout(() => {
      this.readyState = WebSocket.OPEN;
      if (this.onopen) this.onopen();
    }, 0);
  }

  send(data) {
    if (this.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not open');
    }
  }

  close() {
    this.readyState = WebSocket.CLOSED;
    if (this.onclose) this.onclose();
  }
};

WebSocket.CONNECTING = 0;
WebSocket.OPEN = 1;
WebSocket.CLOSING = 2;
WebSocket.CLOSED = 3;

// Mock console methods to reduce noise in tests
global.console = {
  ...console,
  log: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
};

// Test utilities
global.testUtils = {
  /**
   * Create a mock tab connection object
   */
  createMockConnection: (overrides = {}) => ({
    ws: new WebSocket('ws://localhost:3456/ws'),
    sessionId: 'test-session-123',
    sdkSessionId: 'sdk-session-456',
    pageUrl: 'https://example.com',
    status: 'connected',
    ...overrides
  }),

  /**
   * Create a mock Chrome tab object
   */
  createMockTab: (overrides = {}) => ({
    id: 1,
    url: 'https://example.com',
    title: 'Test Page',
    active: true,
    ...overrides
  }),

  /**
   * Simulate a tab switch event
   */
  simulateTabSwitch: (tabId, pageUrl) => {
    const listeners = chrome.tabs.onActivated.addListener.mock.calls;
    if (listeners.length > 0) {
      const listener = listeners[0][0];
      listener({ tabId, windowId: 1 });
    }
  },

  /**
   * Simulate a message from background to sidepanel
   */
  simulateMessage: (message) => {
    const listeners = chrome.runtime.onMessage.addListener.mock.calls;
    if (listeners.length > 0) {
      const listener = listeners[0][0];
      listener(message, {}, jest.fn());
    }
  },

  /**
   * Wait for async operations
   */
  flushPromises: () => new Promise(resolve => setImmediate(resolve))
};

// Reset mocks before each test
beforeEach(() => {
  jest.clearAllMocks();
  if (chrome.runtime) {
    chrome.runtime.lastError = null;
  }
});
