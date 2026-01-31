// Background service worker - manages per-tab WebSocket connections
import type {
  TabConnection,
  ConnectionStatus,
  PermissionMode,
  EditorType,
  EditorProtocolBuilder,
  ServerMessage,
  RuntimeMessage,
  Settings,
  ConnectTabRuntimeMessage,
  DisconnectTabRuntimeMessage,
  UpdateSdkSessionIdRuntimeMessage,
  RegisterTabSessionRuntimeMessage,
  ElementSelectedRuntimeMessage,
  SendChatRuntimeMessage,
  ClearSessionRuntimeMessage,
  CancelRequestRuntimeMessage,
  PermissionModeChangedRuntimeMessage,
  RetryWithPermissionRuntimeMessage,
  CancelPermissionRequestRuntimeMessage,
  GetConnectionStatusRuntimeMessage,
  GetTabConnectionRuntimeMessage,
  PermissionResponseRuntimeMessage,
  UserAnswersRuntimeMessage,
  OpenFileActionMessage
} from './types.js';
import { isValidPermissionMode, isValidEditorType } from './types.js';

const WS_URL = 'ws://localhost:3456/ws';
let currentPermissionMode: PermissionMode = 'plan';

// Per-tab WebSocket connections
const tabConnections: Record<number, TabConnection> = {};
let currentActiveTab: number | null = null;

// Editor protocol builders
const EDITOR_PROTOCOLS: Record<EditorType, EditorProtocolBuilder> = {
  vscode: (filePath: string, lineStart?: number): string => {
    const lineNum = lineStart || 1;
    return `vscode://file${filePath}:${lineNum}:1`;
  },

  cursor: (filePath: string, lineStart?: number): string => {
    const lineNum = lineStart || 1;
    return `cursor://file${filePath}:${lineNum}:1`;
  },

  webstorm: (filePath: string, lineStart?: number): string => {
    const lineParam = lineStart ? `&line=${lineStart}` : '';
    return `webstorm://open?file=${filePath}${lineParam}`;
  },

  sublime: (filePath: string, lineStart?: number): string => {
    const lineNum = lineStart ? `:${lineStart}` : '';
    return `subl://open?url=file://${filePath}${lineNum}`;
  },

  vim: (filePath: string, lineStart?: number): string => {
    // Fallback to VS Code for MVP
    return EDITOR_PROTOCOLS.vscode(filePath, lineStart);
  }
};

function normalizePathForUrl(filePath: string): string {
  // Windows: Convert C:\path to /C:/path
  if (/^[A-Z]:/.test(filePath)) {
    return '/' + filePath.replace(/\\/g, '/');
  }
  return filePath;
}

// Connect to WebSocket server for a specific tab
async function connectTab(tabId: number, pageUrl: string): Promise<TabConnection> {
  // Check if already connected
  if (tabConnections[tabId]?.ws?.readyState === WebSocket.OPEN) {
    console.log(`[TAB ${tabId}] Already connected`);
    return tabConnections[tabId];
  }

  console.log(`[TAB ${tabId}] Connecting to server...`);

  const ws = new WebSocket(WS_URL);
  const connection: TabConnection = {
    ws,
    sessionId: null,
    sdkSessionId: null,
    pageUrl,
    status: 'connecting',
    reconnectTimer: null
  };

  tabConnections[tabId] = connection;

  ws.onopen = async () => {
    console.log(`[TAB ${tabId}] Connected to server`);
    connection.status = 'connected';

    // Retrieve current permission mode from storage
    const result = await chrome.storage.local.get(['permissionMode']) as Settings;
    currentPermissionMode = (result.permissionMode || 'plan') as PermissionMode;

    // Send handshake with tab context
    const handshakeMsg = {
      type: 'handshake',
      permission_mode: currentPermissionMode,
      page_url: pageUrl,
      tab_id: tabId.toString()
    };

    console.log(`[TAB ${tabId}] [WS OUT] handshake`, handshakeMsg);
    ws.send(JSON.stringify(handshakeMsg));

    // Notify side panel if this is the active tab
    if (tabId === currentActiveTab) {
      broadcastStatus('connected', tabId);
    }
  };

  ws.onclose = () => {
    console.log(`[TAB ${tabId}] Disconnected from server`);
    connection.status = 'disconnected';

    // Notify side panel if this is the active tab
    if (tabId === currentActiveTab) {
      broadcastStatus('disconnected', tabId);
    }

    // Attempt reconnection after 3 seconds (only if tab still exists)
    connection.reconnectTimer = setTimeout(async () => {
      try {
        // Check if tab still exists
        await chrome.tabs.get(tabId);
        console.log(`[TAB ${tabId}] Reconnecting...`);
        connectTab(tabId, pageUrl);
      } catch (err) {
        // Tab was closed, cleanup
        console.log(`[TAB ${tabId}] Tab closed, not reconnecting`);
        delete tabConnections[tabId];
      }
    }, 3000);
  };

  ws.onerror = (error: Event) => {
    console.error(`[TAB ${tabId}] WebSocket error:`, error);
    connection.status = 'error';

    if (tabId === currentActiveTab) {
      broadcastStatus('error', tabId);
    }
  };

  ws.onmessage = (event: MessageEvent) => {
    const message = JSON.parse(event.data) as ServerMessage;

    // Handle ping/pong keepalive
    if (message.type === 'ping') {
      console.log(`[TAB ${tabId}] [WS] Received ping, sending pong`);
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    // Store session IDs
    if (message.type === 'handshake_ack') {
      const handshake = message as { type: 'handshake_ack'; session_id: string | null; sdk_session_id?: string | null };
      connection.sessionId = handshake.session_id;
      connection.sdkSessionId = handshake.sdk_session_id || null;
      console.log(`[TAB ${tabId}] Session established: ${connection.sessionId}`);
    }

    // Debug log all incoming messages
    console.log(`[TAB ${tabId}] [WS IN]`, message.type, message);

    // Forward to side panel (only if this is the active tab)
    if (tabId === currentActiveTab) {
      try {
        chrome.runtime.sendMessage({
          type: 'server_message',
          message,
          tabId
        }, () => {
          if (chrome.runtime.lastError) {
            // Side panel not open, that's ok
          }
        });
      } catch (err) {
        // Ignore errors
      }
    }
  };

  return connection;
}

// Disconnect and cleanup a tab's connection
function disconnectTab(tabId: number): void {
  const connection = tabConnections[tabId];
  if (!connection) return;

  console.log(`[TAB ${tabId}] Disconnecting...`);

  // Clear reconnect timer
  if (connection.reconnectTimer) {
    clearTimeout(connection.reconnectTimer);
  }

  // Close WebSocket
  if (connection.ws) {
    connection.ws.close();
  }

  // Remove from map
  delete tabConnections[tabId];
}

// Broadcast connection status to side panel
function broadcastStatus(status: ConnectionStatus, tabId: number): void {
  try {
    chrome.runtime.sendMessage({
      type: 'connection_status',
      status,
      tabId
    }, () => {
      if (chrome.runtime.lastError) {
        // Side panel not open, that's ok
      }
    });
  } catch (err) {
    // Ignore errors
  }
}

// Initialize: load permission mode and set up tab tracking
chrome.storage.local.get(['permissionMode', 'currentActiveTab'], (result: Settings & { currentActiveTab?: number }) => {
  currentPermissionMode = (result.permissionMode || 'plan') as PermissionMode;
  currentActiveTab = result.currentActiveTab || null;
  console.log('[TAB MGMT] Initialized, active tab:', currentActiveTab);
});

// Listen for tab activation (user switches tabs)
chrome.tabs.onActivated.addListener(async (activeInfo: chrome.tabs.TabActiveInfo) => {
  const { tabId } = activeInfo;

  console.log('[TAB MGMT] Tab activated:', tabId);
  currentActiveTab = tabId;
  await chrome.storage.local.set({ currentActiveTab: tabId });

  // Get tab details
  try {
    const tab = await chrome.tabs.get(tabId);

    // Notify side panel about tab switch
    chrome.runtime.sendMessage({
      type: 'tab_switched',
      tabId: tabId,
      pageUrl: tab.url,
      connection: tabConnections[tabId] || null
    }, () => {
      if (chrome.runtime.lastError) {
        // Side panel not open
      }
    });
  } catch (err) {
    console.error('[TAB MGMT] Error getting tab info:', err);
  }
});

// Listen for tab URL changes
chrome.tabs.onUpdated.addListener((tabId: number, changeInfo: chrome.tabs.TabChangeInfo, _tab: chrome.tabs.Tab) => {
  if (changeInfo.url) {
    console.log(`[TAB ${tabId}] URL changed to:`, changeInfo.url);

    // Update stored URL
    if (tabConnections[tabId]) {
      tabConnections[tabId].pageUrl = changeInfo.url;
    }

    // Notify side panel if this is the active tab
    if (tabId === currentActiveTab) {
      chrome.runtime.sendMessage({
        type: 'tab_url_changed',
        tabId: tabId,
        pageUrl: changeInfo.url
      }, () => {
        if (chrome.runtime.lastError) {
          // Side panel not open
        }
      });
    }
  }
});

// Listen for tab closure
chrome.tabs.onRemoved.addListener(async (tabId: number) => {
  console.log(`[TAB ${tabId}] Tab closed, cleaning up connection`);
  disconnectTab(tabId);

  // Clean up SDK session ID from Chrome storage
  const storageKey = `sdk_session_${tabId}`;
  await chrome.storage.local.remove(storageKey);
  console.log(`[TAB ${tabId}] Cleaned up SDK session from storage`);

  if (tabId === currentActiveTab) {
    currentActiveTab = null;
    chrome.storage.local.set({ currentActiveTab: null });
  }
});

// Message Handlers - Each handler receives a typed message and sendResponse callback

function handleOpenFile(message: OpenFileActionMessage, sendResponse: (response?: unknown) => void): boolean {
  const { filePath, lineStart } = message;
  chrome.storage.local.get(['preferredEditor', 'projectPath'], (result) => {
    const editor = isValidEditorType(result.preferredEditor) ? result.preferredEditor : 'vscode';
    const projectPath = result.projectPath || '';

    const normalizedPath = normalizePathForUrl(projectPath ? `${projectPath}/${filePath}` : filePath);
    const editorUrlBuilder = EDITOR_PROTOCOLS[editor];
    const editorUrl = editorUrlBuilder(normalizedPath, lineStart);

    console.log(`Opening file in ${editor}:`, editorUrl);

    chrome.tabs.create({ url: editorUrl, active: false }).then(tab => {
      setTimeout(() => {
        if (tab.id) {
          chrome.tabs.remove(tab.id).catch(() => {});
        }
      }, 500);
    }).catch(err => {
      console.error('Failed to open file:', err);
    });
  });

  sendResponse({ success: true });
  return true;
}

function handleConnectTab(message: ConnectTabRuntimeMessage, sendResponse: (response?: unknown) => void): boolean {
  const { tabId, pageUrl } = message;
  connectTab(tabId, pageUrl).then(connection => {
    sendResponse({
      success: true,
      sessionId: connection.sessionId,
      status: connection.status
    });
  }).catch((err: Error) => {
    console.error(`[TAB ${tabId}] Connection error:`, err);
    sendResponse({ success: false, error: err.message });
  });
  return true;
}

function handleDisconnectTab(message: DisconnectTabRuntimeMessage, sendResponse: (response?: unknown) => void): boolean {
  const { tabId } = message;
  disconnectTab(tabId);
  sendResponse({ success: true });
  return true;
}

function handleUpdateSdkSessionId(message: UpdateSdkSessionIdRuntimeMessage, sendResponse: (response?: unknown) => void): boolean {
  const { tabId, sdkSessionId } = message;
  const connection = tabConnections[tabId];
  if (connection) {
    connection.sdkSessionId = sdkSessionId;
    console.log(`[TAB ${tabId}] SDK session ID updated:`, sdkSessionId);
    sendResponse({ success: true });
  } else {
    console.warn(`[TAB ${tabId}] No connection found to update SDK session ID`);
    sendResponse({ success: false, error: 'No connection found' });
  }
  return true;
}

function handleRegisterTabSession(message: RegisterTabSessionRuntimeMessage, sendResponse: (response?: unknown) => void): boolean {
  const { tabId, sessionId, sdkSessionId, pageUrl } = message;
  const connection = tabConnections[tabId];
  if (connection) {
    connection.sessionId = sessionId;
    connection.sdkSessionId = sdkSessionId;
    connection.pageUrl = pageUrl;
    console.log(`[TAB ${tabId}] Session registered - sessionId: ${sessionId}, sdkSessionId: ${sdkSessionId}`);
    sendResponse({ success: true });
  } else {
    console.warn(`[TAB ${tabId}] No connection found to register session`);
    sendResponse({ success: false, error: 'No connection found' });
  }
  return true;
}

function handleElementSelected(message: ElementSelectedRuntimeMessage, _sendResponse: (response?: unknown) => void): boolean {
  const { context } = message;
  try {
    chrome.runtime.sendMessage({
      type: 'element_captured',
      context: context
    }, () => {
      if (chrome.runtime.lastError) {
        // Side panel not open, that's ok
      }
    });
  } catch (err) {
    // Ignore errors
  }
  return false;
}

function handleSendChat(message: SendChatRuntimeMessage, _sendResponse: (response?: unknown) => void): boolean {
  const tabId = currentActiveTab;
  const connection = tabId !== null ? tabConnections[tabId] : null;
  if (connection?.ws?.readyState === WebSocket.OPEN) {
    const chatMsg = {
      type: 'chat',
      message: message.message,
      selected_text: message.selectedText,
      element_context: message.elementContext
    };
    console.log(`[TAB ${tabId}] [WS OUT] chat`, chatMsg);
    connection.ws.send(JSON.stringify(chatMsg));
  } else {
    console.error(`[TAB ${tabId}] WebSocket not connected`);
  }
  return false;
}

function handleClearSession(_message: ClearSessionRuntimeMessage, _sendResponse: (response?: unknown) => void): boolean {
  const tabId = currentActiveTab;
  const connection = tabId !== null ? tabConnections[tabId] : null;
  if (connection?.ws?.readyState === WebSocket.OPEN) {
    const clearMsg = { type: 'clear_session' };
    console.log(`[TAB ${tabId}] [WS OUT] clear_session`, clearMsg);
    connection.ws.send(JSON.stringify(clearMsg));
  } else {
    console.error(`[TAB ${tabId}] WebSocket not connected`);
  }
  return false;
}

function handleCancelRequest(_message: CancelRequestRuntimeMessage, _sendResponse: (response?: unknown) => void): boolean {
  const tabId = currentActiveTab;
  const connection = tabId !== null ? tabConnections[tabId] : null;
  if (connection?.ws?.readyState === WebSocket.OPEN) {
    const cancelMsg = { type: 'cancel_request' };
    console.log(`[TAB ${tabId}] [WS OUT] cancel_request`, cancelMsg);
    connection.ws.send(JSON.stringify(cancelMsg));
  } else {
    console.error(`[TAB ${tabId}] WebSocket not connected`);
  }
  return false;
}

function handlePermissionModeChanged(message: PermissionModeChangedRuntimeMessage, sendResponse: (response?: unknown) => void): boolean {
  const { mode } = message;
  currentPermissionMode = mode;
  Object.entries(tabConnections).forEach(([tabIdStr, connection]) => {
    if (connection.ws?.readyState === WebSocket.OPEN) {
      const modeMsg = {
        type: 'update_permission_mode',
        mode: mode
      };
      console.log(`[TAB ${tabIdStr}] [WS OUT] update_permission_mode`, modeMsg);
      connection.ws.send(JSON.stringify(modeMsg));
    }
  });
  sendResponse({ success: true });
  return true;
}

function handleRetryWithPermission(_message: RetryWithPermissionRuntimeMessage, sendResponse: (response?: unknown) => void): boolean {
  const tabId = currentActiveTab;
  const connection = tabId !== null ? tabConnections[tabId] : null;
  if (connection?.ws?.readyState === WebSocket.OPEN) {
    const retryMsg = { type: 'retry_with_permission' };
    console.log(`[TAB ${tabId}] [WS OUT] retry_with_permission`, retryMsg);
    connection.ws.send(JSON.stringify(retryMsg));
  } else {
    console.error(`[TAB ${tabId}] WebSocket not connected`);
  }
  sendResponse({ success: true });
  return true;
}

function handleCancelPermissionRequest(_message: CancelPermissionRequestRuntimeMessage, sendResponse: (response?: unknown) => void): boolean {
  const tabId = currentActiveTab;
  const connection = tabId !== null ? tabConnections[tabId] : null;
  if (connection?.ws?.readyState === WebSocket.OPEN) {
    const cancelMsg = { type: 'cancel_permission_request' };
    console.log(`[TAB ${tabId}] [WS OUT] cancel_permission_request`, cancelMsg);
    connection.ws.send(JSON.stringify(cancelMsg));
  }
  sendResponse({ success: true });
  return true;
}

function handleGetConnectionStatus(_message: GetConnectionStatusRuntimeMessage, sendResponse: (response?: unknown) => void): boolean {
  const tabId = currentActiveTab;
  const connection = tabId !== null ? tabConnections[tabId] : null;
  sendResponse({
    connected: connection?.ws?.readyState === WebSocket.OPEN,
    tabId: tabId,
    sessionId: connection?.sessionId || null
  });
  return true;
}

function handleGetTabConnection(message: GetTabConnectionRuntimeMessage, sendResponse: (response?: unknown) => void): boolean {
  const { tabId: requestedTabId } = message;
  const tabId = requestedTabId || currentActiveTab;
  const connection = tabId !== null ? tabConnections[tabId] : null;
  sendResponse({
    tabId: tabId,
    connection: connection || null
  });
  return true;
}

function handleGetSessionId(sendResponse: (response?: unknown) => void): boolean {
  const tabId = currentActiveTab;
  const connection = tabId !== null ? tabConnections[tabId] : null;
  sendResponse({
    sessionId: connection?.sessionId || null,
    connected: connection?.ws?.readyState === WebSocket.OPEN
  });
  return true;
}

function handlePermissionResponse(message: PermissionResponseRuntimeMessage, _sendResponse: (response?: unknown) => void): boolean {
  const tabId = currentActiveTab;
  const connection = tabId !== null ? tabConnections[tabId] : null;
  if (connection?.ws?.readyState === WebSocket.OPEN) {
    const permissionMsg = {
      type: 'permission_response',
      approved: message.approved
    };
    console.log(`[TAB ${tabId}] [WS OUT] permission_response`, permissionMsg);
    connection.ws.send(JSON.stringify(permissionMsg));
  }
  return false;
}

function handleUserAnswers(message: UserAnswersRuntimeMessage, _sendResponse: (response?: unknown) => void): boolean {
  const tabId = currentActiveTab;
  const connection = tabId !== null ? tabConnections[tabId] : null;
  if (connection?.ws?.readyState === WebSocket.OPEN) {
    const answersMsg = {
      type: 'user_answers',
      answers: message.answers
    };
    console.log(`[TAB ${tabId}] [WS OUT] user_answers`, answersMsg);
    connection.ws.send(JSON.stringify(answersMsg));
  }
  return false;
}

function handleToggleClickMode(_message: { type: 'toggle_click_mode' }, _sendResponse: (response?: unknown) => void): boolean {
  // Forward to content script (handled by content.ts)
  return false;
}

// Handle messages from content script and side panel
chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => {
  // Handle OpenFileActionMessage separately (uses 'action' instead of 'type')
  if ('action' in message && message.action === 'openFile') {
    return handleOpenFile(message, sendResponse);
  }

  // At this point, message must have 'type' property (not OpenFileActionMessage)
  if (!('type' in message)) {
    console.warn('Unknown message format:', message);
    return false;
  }

  // Delegate to typed handler functions
  switch (message.type) {
    case 'connect_tab':
      return handleConnectTab(message, sendResponse);
    case 'disconnect_tab':
      return handleDisconnectTab(message, sendResponse);
    case 'update_sdk_session_id':
      return handleUpdateSdkSessionId(message, sendResponse);
    case 'register_tab_session':
      return handleRegisterTabSession(message, sendResponse);
    case 'element_selected':
      return handleElementSelected(message, sendResponse);
    case 'send_chat':
      return handleSendChat(message, sendResponse);
    case 'clear_session':
      return handleClearSession(message, sendResponse);
    case 'cancel_request':
      return handleCancelRequest(message, sendResponse);
    case 'permission_mode_changed':
      return handlePermissionModeChanged(message, sendResponse);
    case 'retry_with_permission':
      return handleRetryWithPermission(message, sendResponse);
    case 'cancel_permission_request':
      return handleCancelPermissionRequest(message, sendResponse);
    case 'get_connection_status':
      return handleGetConnectionStatus(message, sendResponse);
    case 'get_tab_connection':
      return handleGetTabConnection(message, sendResponse);
    case 'get_session_id':
      return handleGetSessionId(sendResponse);
    case 'permission_response':
      return handlePermissionResponse(message, sendResponse);
    case 'user_answers':
      return handleUserAnswers(message, sendResponse);
    case 'toggle_click_mode':
      return handleToggleClickMode(message, sendResponse);
    default:
      console.warn('Unknown message type:', message);
      return false;
  }
});

// Remove duplicate openFile handler below (already handled at top of function)

// Extension icon click - open side panel
// Note: Chrome sidePanel API doesn't support programmatic closing.
// Users must close the panel using the X button.
chrome.action.onClicked.addListener(async (tab: chrome.tabs.Tab) => {
  const windowId = tab.windowId;

  if (windowId !== undefined) {
    try {
      await chrome.sidePanel.open({ windowId });
      console.log('[SIDEPANEL] Opened for window:', windowId);
    } catch (error) {
      console.error('[SIDEPANEL] Failed to open:', error);
    }
  }
});

console.log('UI Chatter background worker started (per-tab WebSocket mode)');

export {};
