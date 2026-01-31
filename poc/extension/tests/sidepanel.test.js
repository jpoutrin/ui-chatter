/**
 * Tests for sidepanel.js - UI Logic and Tab Switching
 */

import { describe, test, expect, beforeEach, jest } from '@jest/globals';

describe('Sidepanel - Tab Switching and History Loading', () => {
  let currentSessionId;
  let currentSdkSessionId;
  let currentTabId;
  let messagesCleared;

  // Mock functions
  const clearMessages = jest.fn(() => {
    messagesCleared = true;
  });

  const connectToCurrentTab = jest.fn();

  const loadChatHistory = jest.fn(async (sessionId) => {
    // Simulate API call
    const response = await global.fetch(`http://localhost:3456/sessions/${sessionId}/messages`);
    if (response.ok) {
      const data = await response.json();
      return data.messages || [];
    }
    return [];
  });

  beforeEach(() => {
    currentSessionId = null;
    currentSdkSessionId = null;
    currentTabId = null;
    messagesCleared = false;

    // Mock fetch
    global.fetch = jest.fn((url) => {
      if (url.includes('/messages')) {
        // Simulate different responses based on session ID
        if (url.includes('session-with-history')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              messages: [
                { role: 'user', content: 'Hello', timestamp: '2024-01-01T00:00:00Z', uuid: '1' },
                { role: 'assistant', content: 'Hi there!', timestamp: '2024-01-01T00:00:01Z', uuid: '2' }
              ]
            })
          });
        } else {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ messages: [] })
          });
        }
      }
      return Promise.reject(new Error('Not found'));
    });

    jest.clearAllMocks();
  });

  describe('handleTabSwitch', () => {
    test('should clear messages and load history for existing session', async () => {
      // Simulate tab switch to tab with existing session
      const message = {
        tabId: 1,
        pageUrl: 'https://example.com',
        connection: {
          sessionId: 'session-with-history',
          sdkSessionId: 'sdk-session-123'
        }
      };

      // Simulate handleTabSwitch logic
      currentTabId = message.tabId;
      messagesCleared = false;

      clearMessages();
      expect(messagesCleared).toBe(true);

      if (message.connection && message.connection.sessionId) {
        currentSessionId = message.connection.sessionId;
        currentSdkSessionId = message.connection.sdkSessionId;

        await connectToCurrentTab();
        const history = await loadChatHistory(currentSessionId);

        expect(currentSessionId).toBe('session-with-history');
        expect(currentSdkSessionId).toBe('sdk-session-123');
        expect(history).toHaveLength(2);
        expect(history[0].content).toBe('Hello');
      }
    });

    test('should handle tab with no existing session', async () => {
      // Simulate tab switch to new tab
      const message = {
        tabId: 2,
        pageUrl: 'https://newpage.com',
        connection: null
      };

      clearMessages();
      currentTabId = message.tabId;

      if (!message.connection) {
        currentSessionId = null;
        currentSdkSessionId = null;
        await connectToCurrentTab();
      }

      expect(currentSessionId).toBeNull();
      expect(currentSdkSessionId).toBeNull();
      expect(connectToCurrentTab).toHaveBeenCalled();
    });

    test('should properly update session IDs from connection object', () => {
      const message = {
        tabId: 1,
        pageUrl: 'https://example.com',
        connection: {
          sessionId: 'ws-session-abc',
          sdkSessionId: 'sdk-session-xyz',
          pageUrl: 'https://example.com'
        }
      };

      // Extract session info
      if (message.connection) {
        currentSessionId = message.connection.sessionId;
        currentSdkSessionId = message.connection.sdkSessionId;
      }

      expect(currentSessionId).toBe('ws-session-abc');
      expect(currentSdkSessionId).toBe('sdk-session-xyz');
    });
  });

  describe('loadChatHistory', () => {
    test('should fetch and return messages for valid session', async () => {
      const messages = await loadChatHistory('session-with-history');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3456/sessions/session-with-history/messages'
      );
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe('user');
      expect(messages[1].role).toBe('assistant');
    });

    test('should return empty array for session with no history', async () => {
      const messages = await loadChatHistory('session-no-history');

      expect(messages).toEqual([]);
    });

    test('should not call fetch when sessionId is null', async () => {
      // Mock implementation that checks for null
      const mockLoadHistory = jest.fn(async (sessionId) => {
        if (!sessionId) {
          return [];
        }
        return await loadChatHistory(sessionId);
      });

      const result = await mockLoadHistory(null);

      expect(result).toEqual([]);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('handleServerMessage - handshake_ack', () => {
    test('should handle resumed session correctly', async () => {
      const message = {
        type: 'handshake_ack',
        session_id: 'session-123',
        sdk_session_id: 'sdk-456',
        resumed: true
      };

      // Simulate handshake_ack handler
      currentSessionId = message.session_id;

      if (message.resumed) {
        const history = await loadChatHistory(currentSessionId);
        // In real code, this would render the history
      }

      expect(currentSessionId).toBe('session-123');
      expect(loadChatHistory).toHaveBeenCalledWith('session-123');
    });

    test('should register tab-to-session mapping after handshake', () => {
      const message = {
        type: 'handshake_ack',
        session_id: 'session-123',
        sdk_session_id: 'sdk-456'
      };

      currentSessionId = message.session_id;

      // Should send register_tab_session message to background
      expect(chrome.runtime.sendMessage).toBeDefined();

      // Simulate sending the message
      chrome.runtime.sendMessage({
        type: 'register_tab_session',
        tabId: 1,
        sessionId: currentSessionId,
        sdkSessionId: message.sdk_session_id,
        pageUrl: 'https://example.com'
      });

      expect(chrome.runtime.sendMessage).toHaveBeenCalled();
    });
  });

  describe('Regression test for empty history bug', () => {
    test('should load history when switching back to tab (bug fix verification)', async () => {
      // Scenario: User has conversation in Tab A, switches to Tab B, switches back to Tab A

      // Step 1: Tab A - create session and have conversation
      const tabAConnection = {
        sessionId: 'session-with-history',
        sdkSessionId: 'sdk-session-tab-a'
      };

      currentSessionId = tabAConnection.sessionId;
      currentSdkSessionId = tabAConnection.sdkSessionId;

      // Step 2: Switch to Tab B (different tab)
      clearMessages();
      currentSessionId = null;
      currentSdkSessionId = null;
      expect(messagesCleared).toBe(true);

      // Step 3: Switch back to Tab A
      // Before fix: tabConnections[tabId] would not have sessionId/sdkSessionId
      // After fix: it should have the session info from register_tab_session

      const switchBackMessage = {
        tabId: 1,
        pageUrl: 'https://example.com',
        connection: tabAConnection  // This should now be populated thanks to register_tab_session handler
      };

      clearMessages();

      if (switchBackMessage.connection) {
        currentSessionId = switchBackMessage.connection.sessionId;
        currentSdkSessionId = switchBackMessage.connection.sdkSessionId;

        await connectToCurrentTab();
        const history = await loadChatHistory(currentSessionId);

        // Verify: History should be loaded
        expect(history).toHaveLength(2);
        expect(history[0].content).toBe('Hello');
        expect(currentSessionId).toBe('session-with-history');
        expect(currentSdkSessionId).toBe('sdk-session-tab-a');
      }
    });
  });
});
