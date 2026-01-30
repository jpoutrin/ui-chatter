// Side panel script
let currentContext = null;
let isConnected = false;

// Multi-channel streaming state
const MessageType = {
  RESPONSE_CHUNK: 'response_chunk',
  TOOL_ACTIVITY: 'tool_activity',
  STREAM_CONTROL: 'stream_control',
  STATUS: 'status',
  ERROR: 'error'
};

const ToolActivityStatus = {
  PENDING: 'pending',
  EXECUTING: 'executing',
  COMPLETED: 'completed',
  FAILED: 'failed'
};

// Active tools tracking
const activeTools = new Map();
let activeToolPanel = null;
let currentStreamId = null;

const elements = {
  statusIndicator: document.getElementById('statusIndicator'),
  statusText: document.getElementById('statusText'),
  selectedElement: document.getElementById('selectedElement'),
  elementTag: document.getElementById('elementTag'),
  messages: document.getElementById('messages'),
  messageInput: document.getElementById('messageInput'),
  sendBtn: document.getElementById('sendBtn'),
  selectBtn: document.getElementById('selectBtn'),
  stopBtn: document.getElementById('stopBtn'),
  thinkingIndicator: document.getElementById('thinkingIndicator')
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

// Handle server messages - multi-channel protocol
function handleServerMessage(message) {
  const { type } = message;

  switch(type) {
    case MessageType.STREAM_CONTROL:
      handleStreamControl(message);
      break;

    case MessageType.RESPONSE_CHUNK:
      handleResponseChunk(message);
      break;

    case MessageType.TOOL_ACTIVITY:
      handleToolActivity(message);
      break;

    case MessageType.STATUS:
      // Legacy status messages
      if (message.status !== 'thinking' && message.status !== 'done') {
        addMessage('status', message.detail || message.status);
      }
      break;

    case MessageType.ERROR:
      addMessage('error', message.message);
      hideStreamingUI();
      break;
  }
}

function handleStreamControl(message) {
  const { action, stream_id, metadata } = message;

  switch(action) {
    case 'started':
      currentStreamId = stream_id;
      showStreamingUI();
      break;

    case 'completed':
      hideStreamingUI();
      if (metadata) {
        console.log('Stream completed:', metadata);
      }
      break;

    case 'cancelled':
      hideStreamingUI();
      addMessage('status', '⏹ Request cancelled');
      break;
  }
}

function handleResponseChunk(message) {
  const { content, done } = message;

  if (done) {
    // Final render with markdown
    if (lastAssistantMessage && lastAssistantMessage.dataset.rawContent) {
      renderMarkdown(lastAssistantMessage);
    }
    return;
  }

  if (!lastAssistantMessage || lastAssistantMessage.className !== 'message assistant') {
    lastAssistantMessage = addMessage('assistant', '');
    lastAssistantMessage.dataset.rawContent = '';
  }

  // Accumulate raw content
  lastAssistantMessage.dataset.rawContent += content;

  // For streaming, show plain text first (markdown rendering is expensive)
  lastAssistantMessage.textContent = lastAssistantMessage.dataset.rawContent;

  elements.messages.scrollTop = elements.messages.scrollHeight;
}

// Render markdown content with syntax highlighting
function renderMarkdown(messageElement) {
  const rawContent = messageElement.dataset.rawContent;
  if (!rawContent) return;

  try {
    // Parse markdown
    const parsed = marked.parse(rawContent);

    // Sanitize HTML
    const sanitized = DOMPurify.sanitize(parsed, {
      ALLOWED_TAGS: [
        'p', 'br', 'strong', 'em', 'code', 'pre',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'ul', 'ol', 'li', 'blockquote', 'a'
      ],
      ALLOWED_ATTR: ['href', 'class'],
      ALLOW_DATA_ATTR: false
    });

    // Set HTML
    messageElement.innerHTML = sanitized;

    // Apply syntax highlighting to code blocks
    messageElement.querySelectorAll('pre code').forEach(block => {
      Prism.highlightElement(block);
    });

    elements.messages.scrollTop = elements.messages.scrollHeight;
  } catch (err) {
    console.error('Error rendering markdown:', err);
    // Fallback to plain text
    messageElement.textContent = rawContent;
  }
}

function handleToolActivity(message) {
  const { tool_id, tool_name, status, input_summary, duration_ms } = message;

  // Update tool map
  activeTools.set(tool_id, {
    name: tool_name,
    status,
    input: input_summary,
    duration: duration_ms,
    timestamp: Date.now()
  });

  // Render tool panel
  renderToolActivityPanel();
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

// Show streaming UI (stop button, thinking indicator)
function showStreamingUI() {
  elements.sendBtn.style.display = 'none';
  elements.stopBtn.style.display = 'inline-block';
  elements.messageInput.disabled = true;
  elements.thinkingIndicator.style.display = 'flex';
}

// Hide streaming UI (restore send button)
function hideStreamingUI() {
  elements.stopBtn.style.display = 'none';
  elements.sendBtn.style.display = 'inline-block';
  elements.messageInput.disabled = false;
  elements.messageInput.focus();
  elements.thinkingIndicator.style.display = 'none';

  // Remove tool panel after fade
  if (activeToolPanel) {
    activeToolPanel.style.opacity = '0.5';
    setTimeout(() => {
      activeToolPanel.remove();
      activeToolPanel = null;
      activeTools.clear();
    }, 500);
  }
}

// Cancel current stream
function cancelStream() {
  if (currentStreamId) {
    chrome.runtime.sendMessage({
      type: 'cancel_request',
      stream_id: currentStreamId
    });
    addMessage('status', 'Cancelling request...');
  }
}

// Render tool activity panel
function renderToolActivityPanel() {
  if (!activeToolPanel) {
    activeToolPanel = document.createElement('div');
    activeToolPanel.className = 'tool-activity-panel';
    elements.messages.appendChild(activeToolPanel);
  }

  const tools = Array.from(activeTools.values());
  const completed = tools.filter(t => t.status === 'completed').length;
  const executing = tools.filter(t => t.status === 'executing').length;
  const pending = tools.filter(t => t.status === 'pending').length;
  const failed = tools.filter(t => t.status === 'failed').length;

  activeToolPanel.innerHTML = `
    <div class="tool-panel-header">
      <span class="tool-icon">⚙️</span>
      <span>Claude is working...</span>
      <button class="cancel-btn" onclick="cancelStream()">Cancel</button>
    </div>
    <div class="tool-list">
      ${tools.map(t => `
        <div class="tool-item tool-${t.status}">
          <span class="tool-status">${getStatusIcon(t.status)}</span>
          <span class="tool-name">${t.name}</span>
          <span class="tool-input">${truncate(t.input || '', 40)}</span>
          <span class="tool-duration">${t.duration ? t.duration + 'ms' : ''}</span>
        </div>
      `).join('')}
    </div>
    <div class="tool-summary">
      ${completed} completed${failed > 0 ? `, ${failed} failed` : ''}${executing > 0 ? `, ${executing} in progress` : ''}${pending > 0 ? `, ${pending} pending` : ''}
    </div>
  `;

  // Auto-scroll to keep visible
  activeToolPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function getStatusIcon(status) {
  const icons = {
    'completed': '✓',
    'executing': '◐',
    'pending': '○',
    'failed': '✗'
  };
  return icons[status] || '?';
}

function truncate(str, maxLength) {
  return str.length > maxLength ? str.substring(0, maxLength) + '...' : str;
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
