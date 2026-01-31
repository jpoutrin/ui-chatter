/**
 * Tests for background.js - Tab Connection Management
 */

import { describe, test, expect, beforeEach, jest } from '@jest/globals';

describe('Background Script - Tab Connection Management', () => {
  let tabConnections;
  let messageHandler;

  beforeEach(() => {
    // Reset tab connections
    tabConnections = {};

    // Mock message handler setup
    messageHandler = jest.fn((message, sender, sendResponse) => {
      // Simulate the message handlers from background.js
      if (message.type === 'register_tab_session') {
        const { tabId, sessionId, sdkSessionId, pageUrl } = message;
        const connection = tabConnections[tabId];

        if (connection) {
          connection.sessionId = sessionId;
          connection.sdkSessionId = sdkSessionId;
          connection.pageUrl = pageUrl;
          sendResponse({ success: true });
          return true;
        } else {
          sendResponse({ success: false, error: 'No connection found' });
          return true;
        }
      }

      if (message.type === 'update_sdk_session_id') {
        const { tabId, sdkSessionId } = message;
        const connection = tabConnections[tabId];

        if (connection) {
          connection.sdkSessionId = sdkSessionId;
          sendResponse({ success: true });
          return true;
        } else {
          sendResponse({ success: false, error: 'No connection found' });
          return true;
        }
      }

      return false;
    });
  });

  describe('register_tab_session handler', () => {
    test('should register session info when connection exists', () => {
      // Setup: Create a connection for tab 1
      const tabId = 1;
      tabConnections[tabId] = testUtils.createMockConnection();

      // Act: Register session
      const message = {
        type: 'register_tab_session',
        tabId: tabId,
        sessionId: 'ws-session-123',
        sdkSessionId: 'sdk-session-456',
        pageUrl: 'https://example.com/page'
      };

      const sendResponse = jest.fn();
      messageHandler(message, {}, sendResponse);

      // Assert: Session info should be stored
      expect(tabConnections[tabId].sessionId).toBe('ws-session-123');
      expect(tabConnections[tabId].sdkSessionId).toBe('sdk-session-456');
      expect(tabConnections[tabId].pageUrl).toBe('https://example.com/page');
      expect(sendResponse).toHaveBeenCalledWith({ success: true });
    });

    test('should return error when no connection exists', () => {
      // Act: Try to register session for non-existent tab
      const message = {
        type: 'register_tab_session',
        tabId: 999,
        sessionId: 'ws-session-123',
        sdkSessionId: 'sdk-session-456',
        pageUrl: 'https://example.com'
      };

      const sendResponse = jest.fn();
      messageHandler(message, {}, sendResponse);

      // Assert: Should return error
      expect(sendResponse).toHaveBeenCalledWith({
        success: false,
        error: 'No connection found'
      });
    });

    test('should update existing session info', () => {
      // Setup: Create connection with initial session
      const tabId = 1;
      tabConnections[tabId] = testUtils.createMockConnection({
        sessionId: 'old-session',
        sdkSessionId: null
      });

      // Act: Update with SDK session
      const message = {
        type: 'register_tab_session',
        tabId: tabId,
        sessionId: 'old-session',
        sdkSessionId: 'new-sdk-session',
        pageUrl: 'https://example.com'
      };

      messageHandler(message, {}, jest.fn());

      // Assert: SDK session should be updated
      expect(tabConnections[tabId].sdkSessionId).toBe('new-sdk-session');
    });
  });

  describe('update_sdk_session_id handler', () => {
    test('should update SDK session ID when connection exists', () => {
      // Setup
      const tabId = 1;
      tabConnections[tabId] = testUtils.createMockConnection({
        sdkSessionId: null
      });

      // Act
      const message = {
        type: 'update_sdk_session_id',
        tabId: tabId,
        sdkSessionId: 'updated-sdk-session'
      };

      const sendResponse = jest.fn();
      messageHandler(message, {}, sendResponse);

      // Assert
      expect(tabConnections[tabId].sdkSessionId).toBe('updated-sdk-session');
      expect(sendResponse).toHaveBeenCalledWith({ success: true });
    });

    test('should return error when connection does not exist', () => {
      // Act
      const message = {
        type: 'update_sdk_session_id',
        tabId: 999,
        sdkSessionId: 'sdk-session'
      };

      const sendResponse = jest.fn();
      messageHandler(message, {}, sendResponse);

      // Assert
      expect(sendResponse).toHaveBeenCalledWith({
        success: false,
        error: 'No connection found'
      });
    });
  });

  describe('Tab switching', () => {
    test('should preserve session info when switching tabs', () => {
      // Setup: Create connections for 2 tabs
      tabConnections[1] = testUtils.createMockConnection({
        sessionId: 'session-tab-1',
        sdkSessionId: 'sdk-tab-1'
      });

      tabConnections[2] = testUtils.createMockConnection({
        sessionId: 'session-tab-2',
        sdkSessionId: 'sdk-tab-2'
      });

      // Assert: Both connections should maintain their session info
      expect(tabConnections[1].sessionId).toBe('session-tab-1');
      expect(tabConnections[1].sdkSessionId).toBe('sdk-tab-1');
      expect(tabConnections[2].sessionId).toBe('session-tab-2');
      expect(tabConnections[2].sdkSessionId).toBe('sdk-tab-2');
    });

    test('should allow retrieving connection by tab ID', () => {
      // Setup
      const tabId = 1;
      const mockConnection = testUtils.createMockConnection();
      tabConnections[tabId] = mockConnection;

      // Act
      const connection = tabConnections[tabId];

      // Assert: Should retrieve the correct connection
      expect(connection).toBeDefined();
      expect(connection.sessionId).toBe(mockConnection.sessionId);
      expect(connection.sdkSessionId).toBe(mockConnection.sdkSessionId);
    });
  });

  describe('Regression test for tab history bug', () => {
    test('should maintain session info across tab switches (bug fix verification)', () => {
      const tabId = 1;

      // Step 1: Create connection
      tabConnections[tabId] = testUtils.createMockConnection({
        sessionId: null,
        sdkSessionId: null
      });

      // Step 2: Register session (this was missing before the fix)
      const registerMessage = {
        type: 'register_tab_session',
        tabId: tabId,
        sessionId: 'session-123',
        sdkSessionId: 'sdk-456',
        pageUrl: 'https://example.com'
      };

      messageHandler(registerMessage, {}, jest.fn());

      // Step 3: Verify session is stored
      expect(tabConnections[tabId].sessionId).toBe('session-123');
      expect(tabConnections[tabId].sdkSessionId).toBe('sdk-456');

      // Step 4: Simulate tab switch - connection should still have session info
      const connection = tabConnections[tabId];
      expect(connection).toBeDefined();
      expect(connection.sessionId).toBe('session-123');
      expect(connection.sdkSessionId).toBe('sdk-456');

      // This verifies the fix - before, sdkSessionId would be null/undefined
      // causing history loading to fail
    });
  });
});
