// Background service worker - manages WebSocket connection
const WS_URL = 'ws://localhost:3456/ws';
let ws = null;
let reconnectTimer = null;
let currentPermissionMode = 'plan';

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

// Connect to WebSocket server
async function connect() {
  if (ws?.readyState === WebSocket.OPEN) return;

  console.log('Connecting to server...');
  ws = new WebSocket(WS_URL);

  ws.onopen = async () => {
    console.log('Connected to POC server');

    // Retrieve current permission mode from storage
    const result = await chrome.storage.local.get(['permissionMode']);
    currentPermissionMode = result.permissionMode || 'plan';

    // Send handshake with permission mode
    const handshakeMsg = {
      type: 'handshake',
      permission_mode: currentPermissionMode
    };
    console.log('[WS OUT] handshake', handshakeMsg);
    ws.send(JSON.stringify(handshakeMsg));
    broadcastStatus('connected');
  };

  ws.onclose = () => {
    console.log('Disconnected from server');
    broadcastStatus('disconnected');
    // Reconnect after 3 seconds
    reconnectTimer = setTimeout(connect, 3000);
  };

  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
    broadcastStatus('error');
  };

  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);

    // Handle ping/pong keepalive
    if (message.type === 'ping') {
      console.log('[WS] Received ping, sending pong');
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    // Debug log all incoming messages
    console.log('[WS IN]', message.type, message);

    // Forward to side panel (ignore if not open)
    try {
      chrome.runtime.sendMessage({
        type: 'server_message',
        message
      }, () => {
        if (chrome.runtime.lastError) {
          // Side panel not open, that's ok
        }
      });
    } catch (err) {
      // Ignore errors
    }
  };
}

// Store connection status
let connectionStatus = 'disconnected';

// Broadcast connection status to all tabs
function broadcastStatus(status) {
  connectionStatus = status;
  // Try to send, but ignore if no one is listening
  try {
    chrome.runtime.sendMessage({
      type: 'connection_status',
      status
    }, () => {
      // Ignore errors if no receiver
      if (chrome.runtime.lastError) {
        // Side panel not open, that's ok
      }
    });
  } catch (err) {
    // Ignore errors
  }
}

// Handle messages from content script and side panel
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'element_selected') {
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
  } else if (message.type === 'send_chat') {
    // Send chat message to server
    if (ws?.readyState === WebSocket.OPEN) {
      const chatMsg = {
        type: 'chat',
        context: message.context,
        message: message.message
      };
      console.log('[WS OUT] chat', chatMsg);
      ws.send(JSON.stringify(chatMsg));
    } else {
      console.error('WebSocket not connected');
    }
  } else if (message.type === 'permission_mode_changed') {
    // Update current mode and notify server
    currentPermissionMode = message.mode;

    if (ws?.readyState === WebSocket.OPEN) {
      const modeMsg = {
        type: 'update_permission_mode',
        mode: message.mode
      };
      console.log('[WS OUT] update_permission_mode', modeMsg);
      ws.send(JSON.stringify(modeMsg));
    }

    sendResponse({ success: true });
    return true;
  } else if (message.type === 'retry_with_permission') {
    // User clicked "Allow and Retry" button
    if (ws?.readyState === WebSocket.OPEN) {
      const retryMsg = {
        type: 'retry_with_permission'
      };
      console.log('[WS OUT] retry_with_permission', retryMsg);
      ws.send(JSON.stringify(retryMsg));
    } else {
      console.error('WebSocket not connected');
    }
    sendResponse({ success: true });
    return true;
  } else if (message.type === 'cancel_permission_request') {
    // User clicked "Cancel" button
    if (ws?.readyState === WebSocket.OPEN) {
      const cancelMsg = {
        type: 'cancel_permission_request'
      };
      console.log('[WS OUT] cancel_permission_request', cancelMsg);
      ws.send(JSON.stringify(cancelMsg));
    }
    sendResponse({ success: true });
    return true;
  } else if (message.type === 'get_connection_status') {
    sendResponse({
      connected: ws?.readyState === WebSocket.OPEN
    });
    return true; // Keep channel open for async response
  } else if (message.action === 'openFile') {
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
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});

// Initialize connection on startup
connect();

console.log('UI Chatter background worker started');
