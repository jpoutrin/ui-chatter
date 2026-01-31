// Background service worker - manages per-tab WebSocket connections
import type {
  TabConnection,
  ConnectionStatus,
  PermissionMode,
  EditorType,
  EditorProtocolBuilder,
  ServerMessage,
  RuntimeMessage,
  Settings
} from './types';

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
chrome.tabs.onRemoved.addListener((tabId: number) => {
  console.log(`[TAB ${tabId}] Tab closed, cleaning up connection`);
  disconnectTab(tabId);

  if (tabId === currentActiveTab) {
    currentActiveTab = null;
    chrome.storage.local.set({ currentActiveTab: null });
  }
});

// Handle messages from content script and side panel
chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => {
  const msg = message as { type?: string; action?: string; [key: string]: unknown };

  if (msg.type === 'connect_tab') {
    // Side panel requesting connection for a specific tab
    const { tabId, pageUrl } = message as { type: string; tabId: number; pageUrl: string };

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

    return true; // Keep channel open for async response
  }

  else if (msg.type === 'disconnect_tab') {
    // Side panel disconnecting from a tab
    const { tabId } = message as { type: string; tabId: number };
    disconnectTab(tabId);
    sendResponse({ success: true });
    return true;
  }

  else if (msg.type === 'update_sdk_session_id') {
    // Update SDK session ID for a tab
    const { tabId, sdkSessionId } = msg as { type: string; tabId: number; sdkSessionId: string };
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

  else if (msg.type === 'register_tab_session') {
    // Register or update tab session info after handshake
    const { tabId, sessionId, sdkSessionId, pageUrl } = msg as { type: string; tabId: number; sessionId: string; sdkSessionId: string | null; pageUrl: string };
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

  else if (msg.type === 'element_selected') {
    // Forward to side panel (ignore if not open)
    const { context } = message as { type: string; context: unknown };
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
  }

  else if (msg.type === 'send_chat') {
    // Send chat message to server for the active tab
    const tabId = currentActiveTab;
    const connection = tabId !== null ? tabConnections[tabId] : null;

    if (connection?.ws?.readyState === WebSocket.OPEN) {
      const chatMsg = {
        type: 'chat',
        context: (message as { context?: unknown }).context,
        message: (message as { message: string }).message
      };
      console.log(`[TAB ${tabId}] [WS OUT] chat`, chatMsg);
      connection.ws.send(JSON.stringify(chatMsg));
    } else {
      console.error(`[TAB ${tabId}] WebSocket not connected`);
    }
  }

  else if (msg.type === 'clear_session') {
    // Clear session and start new conversation
    const tabId = currentActiveTab;
    const connection = tabId !== null ? tabConnections[tabId] : null;

    if (connection?.ws?.readyState === WebSocket.OPEN) {
      const clearMsg = {
        type: 'clear_session'
      };
      console.log(`[TAB ${tabId}] [WS OUT] clear_session`, clearMsg);
      connection.ws.send(JSON.stringify(clearMsg));
    } else {
      console.error(`[TAB ${tabId}] WebSocket not connected`);
    }
  }

  else if (msg.type === 'cancel_request') {
    // Cancel current stream for the active tab
    const tabId = currentActiveTab;
    const connection = tabId !== null ? tabConnections[tabId] : null;

    if (connection?.ws?.readyState === WebSocket.OPEN) {
      const cancelMsg = {
        type: 'cancel_request',
        stream_id: (message as { stream_id?: string }).stream_id
      };
      console.log(`[TAB ${tabId}] [WS OUT] cancel_request`, cancelMsg);
      connection.ws.send(JSON.stringify(cancelMsg));
    } else {
      console.error(`[TAB ${tabId}] WebSocket not connected`);
    }
  }

  else if (msg.type === 'permission_mode_changed') {
    // Update current mode and notify all active connections
    const { mode } = message as { type: string; mode: PermissionMode };
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

  else if (msg.type === 'retry_with_permission') {
    // User clicked "Allow and Retry" button
    const tabId = currentActiveTab;
    const connection = tabId !== null ? tabConnections[tabId] : null;

    if (connection?.ws?.readyState === WebSocket.OPEN) {
      const retryMsg = {
        type: 'retry_with_permission'
      };
      console.log(`[TAB ${tabId}] [WS OUT] retry_with_permission`, retryMsg);
      connection.ws.send(JSON.stringify(retryMsg));
    } else {
      console.error(`[TAB ${tabId}] WebSocket not connected`);
    }
    sendResponse({ success: true });
    return true;
  }

  else if (msg.type === 'cancel_permission_request') {
    // User clicked "Cancel" button
    const tabId = currentActiveTab;
    const connection = tabId !== null ? tabConnections[tabId] : null;

    if (connection?.ws?.readyState === WebSocket.OPEN) {
      const cancelMsg = {
        type: 'cancel_permission_request'
      };
      console.log(`[TAB ${tabId}] [WS OUT] cancel_permission_request`, cancelMsg);
      connection.ws.send(JSON.stringify(cancelMsg));
    }
    sendResponse({ success: true });
    return true;
  }

  else if (msg.type === 'get_connection_status') {
    const tabId = currentActiveTab;
    const connection = tabId !== null ? tabConnections[tabId] : null;

    sendResponse({
      connected: connection?.ws?.readyState === WebSocket.OPEN,
      tabId: tabId,
      sessionId: connection?.sessionId || null
    });
    return true;
  }

  else if (msg.type === 'get_tab_connection') {
    // Get full connection info for a specific tab (or current tab if not specified)
    const requestedTabId = (message as { tabId?: number }).tabId;
    const tabId = requestedTabId || currentActiveTab;
    const connection = tabId !== null ? tabConnections[tabId] : null;

    sendResponse({
      tabId: tabId,
      connection: connection || null
    });
    return true;
  }

  else if ((msg as { action?: string }).action === 'openFile') {
    // Open file in editor with dynamic protocol support
    const { filePath, lineStart } = message as { action: string; filePath: string; lineStart?: number };
    chrome.storage.local.get(['preferredEditor', 'projectPath'], (result: Settings) => {
      const editor = (result.preferredEditor || 'vscode') as EditorType;
      const projectPath = result.projectPath || '';

      // Ensure absolute path
      const absolutePath = filePath.startsWith('/') || /^[A-Z]:/.test(filePath)
        ? filePath
        : (projectPath ? `${projectPath}/${filePath}` : filePath);

      // Normalize Windows paths
      const normalizedPath = normalizePathForUrl(absolutePath);

      // Build editor URL
      const editorUrlBuilder = EDITOR_PROTOCOLS[editor] || EDITOR_PROTOCOLS.vscode;
      const editorUrl = editorUrlBuilder(normalizedPath, lineStart);

      console.log(`Opening file in ${editor}:`, editorUrl);

      // Open in new tab (triggers editor protocol)
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
});

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
