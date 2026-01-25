// Background service worker - manages WebSocket connection
const WS_URL = 'ws://localhost:3456/ws';
let ws = null;
let reconnectTimer = null;

// Connect to WebSocket server
function connect() {
  if (ws?.readyState === WebSocket.OPEN) return;

  console.log('Connecting to server...');
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log('Connected to POC server');
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
      ws.send(JSON.stringify({
        type: 'chat',
        context: message.context,
        message: message.message
      }));
    } else {
      console.error('WebSocket not connected');
    }
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
