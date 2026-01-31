// Background service worker - manages per-tab WebSocket connections
const WS_URL = 'ws://localhost:3456/ws';
let currentPermissionMode = 'plan';

// Per-tab WebSocket connections
// tabId -> {ws, sessionId, sdkSessionId, reconnectTimer, pageUrl, status}
let tabConnections = {};
let currentActiveTab = null;

// Editor protocol builders
const EDITOR_PROTOCOLS = {
  vscode: (filePath, lineStart) => {
    const lineNum = lineStart || 1;
    return `vscode://file${filePath}:${lineNum}:1`;
  },

  cursor: (filePath, lineStart) => {
    const lineNum = lineStart || 1;
    return `cursor://file${filePath}:${lineNum}:1`;
  },

  webstorm: (filePath, lineStart) => {
    const lineParam = lineStart ? `&line=${lineStart}` : '';
    return `webstorm://open?file=${filePath}${lineParam}`;
  },

  sublime: (filePath, lineStart) => {
    const lineNum = lineStart ? `:${lineStart}` : '';
    return `subl://open?url=file://${filePath}${lineNum}`;
  },

  vim: (filePath, lineStart) => {
    // Fallback to VS Code for MVP
    return EDITOR_PROTOCOLS.vscode(filePath, lineStart);
  }
};

function normalizePathForUrl(filePath) {
  // Windows: Convert C:\path to /C:/path
  if (/^[A-Z]:/.test(filePath)) {
    return '/' + filePath.replace(/\\/g, '/');
  }
  return filePath;
}

// Connect to WebSocket server for a specific tab
async function connectTab(tabId, pageUrl) {
  // Check if already connected
  if (tabConnections[tabId]?.ws?.readyState === WebSocket.OPEN) {
    console.log(`[TAB ${tabId}] Already connected`);
    return tabConnections[tabId];
  }

  console.log(`[TAB ${tabId}] Connecting to server...`);

  const ws = new WebSocket(WS_URL);
  const connection = {
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
    const result = await chrome.storage.local.get(['permissionMode']);
    currentPermissionMode = result.permissionMode || 'plan';

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

  ws.onerror = (error) => {
    console.error(`[TAB ${tabId}] WebSocket error:`, error);
    connection.status = 'error';

    if (tabId === currentActiveTab) {
      broadcastStatus('error', tabId);
    }
  };

  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);

    // Handle ping/pong keepalive
    if (message.type === 'ping') {
      console.log(`[TAB ${tabId}] [WS] Received ping, sending pong`);
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    // Store session IDs
    if (message.type === 'handshake_ack') {
      connection.sessionId = message.session_id;
      connection.sdkSessionId = message.sdk_session_id || null;
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
function disconnectTab(tabId) {
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
function broadcastStatus(status, tabId) {
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
chrome.storage.local.get(['permissionMode', 'currentActiveTab'], (result) => {
  currentPermissionMode = result.permissionMode || 'plan';
  currentActiveTab = result.currentActiveTab || null;
  console.log('[TAB MGMT] Initialized, active tab:', currentActiveTab);
});

// Listen for tab activation (user switches tabs)
chrome.tabs.onActivated.addListener(async (activeInfo) => {
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
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
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
chrome.tabs.onRemoved.addListener((tabId) => {
  console.log(`[TAB ${tabId}] Tab closed, cleaning up connection`);
  disconnectTab(tabId);

  if (tabId === currentActiveTab) {
    currentActiveTab = null;
    chrome.storage.local.set({ currentActiveTab: null });
  }
});

// Handle messages from content script and side panel
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'connect_tab') {
    // Side panel requesting connection for a specific tab
    const { tabId, pageUrl } = message;

    connectTab(tabId, pageUrl).then(connection => {
      sendResponse({
        success: true,
        sessionId: connection.sessionId,
        status: connection.status
      });
    }).catch(err => {
      console.error(`[TAB ${tabId}] Connection error:`, err);
      sendResponse({ success: false, error: err.message });
    });

    return true; // Keep channel open for async response
  }

  else if (message.type === 'disconnect_tab') {
    // Side panel disconnecting from a tab
    const { tabId } = message;
    disconnectTab(tabId);
    sendResponse({ success: true });
    return true;
  }

  else if (message.type === 'update_sdk_session_id') {
    // Update SDK session ID for a tab
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

  else if (message.type === 'element_selected') {
    // Forward to side panel (ignore if not open)
    try {
      chrome.runtime.sendMessage({
        type: 'element_captured',
        context: message.context
      }, () => {
        if (chrome.runtime.lastError) {
          // Side panel not open, that's ok
        }
      });
    } catch (err) {
      // Ignore errors
    }
  }

  else if (message.type === 'send_chat') {
    // Send chat message to server for the active tab
    const tabId = currentActiveTab;
    const connection = tabConnections[tabId];

    if (connection?.ws?.readyState === WebSocket.OPEN) {
      const chatMsg = {
        type: 'chat',
        context: message.context,
        message: message.message
      };
      console.log(`[TAB ${tabId}] [WS OUT] chat`, chatMsg);
      connection.ws.send(JSON.stringify(chatMsg));
    } else {
      console.error(`[TAB ${tabId}] WebSocket not connected`);
    }
  }

  else if (message.type === 'clear_session') {
    // Clear session and start new conversation
    const tabId = currentActiveTab;
    const connection = tabConnections[tabId];

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

  else if (message.type === 'cancel_request') {
    // Cancel current stream for the active tab
    const tabId = currentActiveTab;
    const connection = tabConnections[tabId];

    if (connection?.ws?.readyState === WebSocket.OPEN) {
      const cancelMsg = {
        type: 'cancel_request',
        stream_id: message.stream_id
      };
      console.log(`[TAB ${tabId}] [WS OUT] cancel_request`, cancelMsg);
      connection.ws.send(JSON.stringify(cancelMsg));
    } else {
      console.error(`[TAB ${tabId}] WebSocket not connected`);
    }
  }

  else if (message.type === 'permission_mode_changed') {
    // Update current mode and notify all active connections
    currentPermissionMode = message.mode;

    Object.entries(tabConnections).forEach(([tabId, connection]) => {
      if (connection.ws?.readyState === WebSocket.OPEN) {
        const modeMsg = {
          type: 'update_permission_mode',
          mode: message.mode
        };
        console.log(`[TAB ${tabId}] [WS OUT] update_permission_mode`, modeMsg);
        connection.ws.send(JSON.stringify(modeMsg));
      }
    });

    sendResponse({ success: true });
    return true;
  }

  else if (message.type === 'retry_with_permission') {
    // User clicked "Allow and Retry" button
    const tabId = currentActiveTab;
    const connection = tabConnections[tabId];

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

  else if (message.type === 'cancel_permission_request') {
    // User clicked "Cancel" button
    const tabId = currentActiveTab;
    const connection = tabConnections[tabId];

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

  else if (message.type === 'get_connection_status') {
    const tabId = currentActiveTab;
    const connection = tabConnections[tabId];

    sendResponse({
      connected: connection?.ws?.readyState === WebSocket.OPEN,
      tabId: tabId,
      sessionId: connection?.sessionId || null
    });
    return true;
  }

  else if (message.type === 'get_tab_connection') {
    // Get full connection info for a specific tab (or current tab if not specified)
    const tabId = message.tabId || currentActiveTab;
    const connection = tabConnections[tabId];

    sendResponse({
      tabId: tabId,
      connection: connection || null
    });
    return true;
  }

  else if (message.action === 'openFile') {
    // Open file in editor with dynamic protocol support
    chrome.storage.local.get(['preferredEditor', 'projectPath'], (result) => {
      const editor = result.preferredEditor || 'vscode';
      const projectPath = result.projectPath || '';
      const filePath = message.filePath;
      const lineStart = message.lineStart;

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
          chrome.tabs.remove(tab.id).catch(() => {});
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
chrome.action.onClicked.addListener(async (tab) => {
  const windowId = tab.windowId;

  try {
    await chrome.sidePanel.open({ windowId });
    console.log('[SIDEPANEL] Opened for window:', windowId);
  } catch (error) {
    console.error('[SIDEPANEL] Failed to open:', error);
  }
});

console.log('UI Chatter background worker started (per-tab WebSocket mode)');
