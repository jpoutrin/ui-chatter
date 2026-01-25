// Side panel script
let currentContext = null;
let isConnected = false;

const elements = {
  statusIndicator: document.getElementById('statusIndicator'),
  statusText: document.getElementById('statusText'),
  selectedElement: document.getElementById('selectedElement'),
  elementTag: document.getElementById('elementTag'),
  messages: document.getElementById('messages'),
  messageInput: document.getElementById('messageInput'),
  sendBtn: document.getElementById('sendBtn'),
  selectBtn: document.getElementById('selectBtn')
};

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'connection_status') {
    updateConnectionStatus(message.status === 'connected');
  } else if (message.type === 'element_captured') {
    handleElementCaptured(message.context);
  } else if (message.type === 'server_message') {
    handleServerMessage(message.message);
  }
});

// Update connection status UI
function updateConnectionStatus(connected) {
  isConnected = connected;
  if (connected) {
    elements.statusIndicator.classList.add('connected');
    elements.statusText.textContent = 'Connected';
  } else {
    elements.statusIndicator.classList.remove('connected');
    elements.statusText.textContent = 'Not connected';
  }
}

// Handle element selection
function handleElementCaptured(context) {
  currentContext = context;
  const el = context.element;

  // Show selected element
  elements.selectedElement.classList.add('visible');
  elements.elementTag.textContent = `<${el.tagName}${el.id ? ` id="${el.id}"` : ''}${el.classList.length ? ` class="${el.classList.join(' ')}"` : ''}>`;

  // Enable input
  elements.messageInput.disabled = false;
  elements.sendBtn.disabled = false;
  elements.messageInput.focus();

  // Add message
  addMessage('status', `Element selected: ${el.tagName}`);
}

// Handle server messages
function handleServerMessage(message) {
  if (message.type === 'response_chunk') {
    if (message.done) {
      addMessage('status', 'Response complete');
    } else {
      appendToLastMessage(message.content);
    }
  } else if (message.type === 'status') {
    addMessage('status', message.detail || message.status);
  }
}

// Add message to chat
function addMessage(role, content) {
  const messageDiv = document.createElement('div');
  messageDiv.className = `message ${role}`;
  messageDiv.textContent = content;
  elements.messages.appendChild(messageDiv);
  elements.messages.scrollTop = elements.messages.scrollHeight;
  return messageDiv;
}

// Append to last assistant message or create new one
let lastAssistantMessage = null;
function appendToLastMessage(content) {
  if (!lastAssistantMessage || lastAssistantMessage.className !== 'message assistant') {
    lastAssistantMessage = addMessage('assistant', '');
  }
  lastAssistantMessage.textContent += content;
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

// Select element button
elements.selectBtn.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Check if the page is a valid web page
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:')) {
      addMessage('status', 'Error: Please navigate to a regular web page first (http:// or https://)');
      return;
    }

    // Try to send message to content script
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'toggle_click_mode' });
      addMessage('status', 'Click mode activated - select an element on the page');
    } catch (err) {
      // Content script not loaded, inject it
      console.log('Content script not loaded, injecting...');

      // Inject CSS
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ['content.css']
      });

      // Inject JS
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      });

      // Wait a bit for script to initialize
      await new Promise(resolve => setTimeout(resolve, 100));

      // Try again
      await chrome.tabs.sendMessage(tab.id, { type: 'toggle_click_mode' });
      addMessage('status', 'Click mode activated - select an element on the page');
    }
  } catch (err) {
    console.error('Error toggling click mode:', err);
    addMessage('status', 'Error: Cannot access this page. Try refreshing the page first.');
  }
});

// Send message
function sendMessage() {
  const message = elements.messageInput.value.trim();
  if (!message || !currentContext) return;

  // Add user message to chat
  addMessage('user', message);

  // Clear input
  elements.messageInput.value = '';

  // Reset last assistant message
  lastAssistantMessage = null;

  // Send to background script
  chrome.runtime.sendMessage({
    type: 'send_chat',
    context: currentContext,
    message
  });
}

elements.sendBtn.addEventListener('click', sendMessage);
elements.messageInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') sendMessage();
});

// Check initial connection status
chrome.runtime.sendMessage({ type: 'get_connection_status' }, (response) => {
  if (chrome.runtime.lastError) {
    console.log('Background not ready yet:', chrome.runtime.lastError);
    return;
  }
  if (response?.connected) {
    updateConnectionStatus(true);
  }
});

console.log('Side panel loaded');
