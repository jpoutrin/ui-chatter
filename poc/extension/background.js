// Background service worker - manages WebSocket connection
const WS_URL = 'ws://localhost:3456/ws';
let ws = null;
let reconnectTimer = null;
let currentPermissionMode = 'plan';

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
  } else if (message.type === 'get_connection_status') {
    sendResponse({
      connected: ws?.readyState === WebSocket.OPEN
    });
    return true; // Keep channel open for async response
  }
});

// Extension icon click - open side panel
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});

// Initialize connection on startup
connect();

console.log('UI Chatter background worker started');
