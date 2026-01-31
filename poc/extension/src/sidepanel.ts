// @ts-nocheck
// Side panel script
let currentContext = null;
let isConnected = false;
let currentSessionId = null;  // WebSocket session ID
let currentSdkSessionId = null;  // Agent SDK session ID
let selectedSdkSessionId = null;  // User's selected SDK session (before connection)

// Tab tracking for per-tab connections
let currentTabId = null;  // Browser tab ID currently being displayed

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

// Permission modal state
let currentPermissionRequest = null;
let permissionTimer = null;

// Markdown library load state
let librariesLoaded = false;

// Check if markdown libraries are available
function checkLibraries() {
  if (typeof marked !== 'undefined' &&
      typeof DOMPurify !== 'undefined' &&
      typeof Prism !== 'undefined') {
    librariesLoaded = true;
    console.log('✓ Markdown libraries loaded');
    return true;
  }
  return false;
}

const elements = {
  statusIndicator: document.getElementById('statusIndicator'),
  statusText: document.getElementById('statusText'),
  selectedElement: document.getElementById('selectedElement'),
  permissionModeSelect: document.getElementById('permissionModeSelect'),
  elementTag: document.getElementById('elementTag'),
  messages: document.getElementById('messages'),
  messageInput: document.getElementById('messageInput'),
  sendBtn: document.getElementById('sendBtn'),
  selectBtn: document.getElementById('selectBtn'),
  stopBtn: document.getElementById('stopBtn'),
  thinkingIndicator: document.getElementById('thinkingIndicator'),
  sessionSelector: document.getElementById('sessionSelector'),
  sdkSessionSelect: document.getElementById('sdkSessionSelect'),
  sessionBadge: document.getElementById('sessionBadge'),
  tabIndicator: document.getElementById('tabIndicator'),
  tabIndicatorText: document.getElementById('tabIndicatorText')
};

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'connection_status') {
    updateConnectionStatus(message.status === 'connected');
  } else if (message.type === 'element_captured') {
    handleElementCaptured(message.context);
  } else if (message.type === 'server_message') {
    handleServerMessage(message.message);
  } else if (message.type === 'tab_switched') {
    // NEW: Handle tab switch
    handleTabSwitch(message);
  } else if (message.type === 'tab_url_changed') {
    // NEW: Handle URL change within tab
    handleTabUrlChange(message);
  }
});

// Update connection status UI
function updateConnectionStatus(connected) {
  isConnected = connected;
  if (connected) {
    elements.statusIndicator.classList.add('connected');
    elements.statusText.textContent = 'Connected';

    // Fetch SDK sessions when connected
    fetchSdkSessions();
  } else {
    elements.statusIndicator.classList.remove('connected');
    elements.statusText.textContent = 'Not connected';

    // Hide session selector when disconnected
    elements.sessionSelector.style.display = 'none';
  }
}

// Fetch Agent SDK sessions from REST API
async function fetchSdkSessions() {
  try {
    const response = await fetch('http://localhost:3456/api/v1/agent-sessions');
    if (!response.ok) {
      console.error('Failed to fetch SDK sessions:', response.statusText);
      return;
    }

    const data = await response.json();
    const sessions = data.agent_sessions || [];

    // Always show selector (even if no resumable sessions yet)
    elements.sessionSelector.style.display = 'flex';
    populateSessionDropdown(sessions);
  } catch (error) {
    console.error('Error fetching SDK sessions:', error);
  }
}

// Populate the session dropdown
function populateSessionDropdown(sessions) {
  const select = elements.sdkSessionSelect;

  // Clear existing options
  select.innerHTML = '';

  // Add "Current session" option
  const currentOption = document.createElement('option');
  currentOption.value = '';
  currentOption.textContent = '(Current session)';
  select.appendChild(currentOption);

  // Add separator
  if (sessions.length > 0) {
    const separator = document.createElement('option');
    separator.disabled = true;
    separator.textContent = '──────────────';
    select.appendChild(separator);
  }

  // Add each SDK session
  sessions.forEach(session => {
    const option = document.createElement('option');
    option.value = session.sdk_session_id;

    // Format: "Title - Last active: timestamp"
    const lastActive = new Date(session.last_activity).toLocaleString();
    option.textContent = `${session.title} - ${lastActive}`;

    select.appendChild(option);
  });

  // Enable dropdown
  select.disabled = false;

  // Add change handler
  select.onchange = handleSessionSwitch;

  console.log(`Loaded ${sessions.length} SDK sessions`);
}

// Fetch and display chat history for a session
async function loadChatHistory(sessionId) {
  console.log('[UI CHATTER] Loading chat history for session:', sessionId);

  if (!sessionId) {
    console.warn('[UI CHATTER] No session ID provided');
    return;
  }

  try {
    const url = `http://localhost:3456/sessions/${sessionId}/messages`;
    console.log('[UI CHATTER] Fetching from:', url);

    const response = await fetch(url);

    if (!response.ok) {
      console.warn('[UI CHATTER] No history available for this session, status:', response.status);
      return;
    }

    const data = await response.json();
    const messages = data.messages || [];

    console.log('[UI CHATTER] Loaded', messages.length, 'messages:', messages);

    // Helper to extract text from message content (handles both string and array formats)
    const extractText = (content) => {
      if (typeof content === 'string') {
        return content;
      }
      if (Array.isArray(content)) {
        // Claude API format: [{type: "text", text: "..."}, ...]
        return content
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('\n');
      }
      return String(content);
    };

    // Don't clear - messages were already cleared by handleTabSwitch
    // Render each message (skip empty messages and tool-only messages)
    messages.forEach(msg => {
      const textContent = extractText(msg.content);

      // Skip empty messages (tool results, empty user messages)
      if (!textContent || textContent.trim() === '') {
        console.log('[UI CHATTER] Skipping empty message:', msg.role, msg.uuid);
        return;
      }

      console.log('[UI CHATTER] Rendering message:', msg.role, textContent.substring(0, 50));
      if (msg.role === 'user') {
        addMessage('user', textContent);
      } else if (msg.role === 'assistant') {
        const msgEl = addMessage('assistant', '');
        msgEl.dataset.rawContent = textContent;
        renderMarkdown(msgEl);
      }
    });

    if (messages.length > 0) {
      console.log('[UI CHATTER] History loaded successfully, total messages in DOM:', elements.messages.children.length);
    } else {
      console.log('[UI CHATTER] No messages to display');
    }
  } catch (error) {
    console.error('[UI CHATTER] Error loading history:', error);
    addMessage('error', `Failed to load history: ${error.message}`);
  }
}

// Handle session switch
async function handleSessionSwitch(event) {
  const targetSdkSessionId = event.target.value;

  // Empty value means stay on current session
  if (!targetSdkSessionId) {
    return;
  }

  console.log('[UI CHATTER] Session switch requested:', targetSdkSessionId);

  // Cancel any active stream before switching
  if (currentStreamId) {
    console.log('[UI CHATTER] Cancelling active stream before switch:', currentStreamId);
    cancelStream();

    // Wait briefly for cancellation to process
    await new Promise(resolve => setTimeout(resolve, 500));

    // Hide tool activity panel if present
    if (activeToolPanel) {
      activeToolPanel.remove();
      activeToolPanel = null;
    }

    // Hide thinking indicator
    elements.thinkingIndicator.style.display = 'none';

    // Clear active tools
    activeTools.clear();
    currentStreamId = null;
  }

  // Get current WebSocket session ID from background
  chrome.runtime.sendMessage({ type: 'get_session_id' }, async (response) => {
    if (!response || !response.sessionId) {
      // No active session yet - store selection for when connection is established
      selectedSdkSessionId = targetSdkSessionId;
      console.log('[UI CHATTER] No active connection, session selection stored');
      addMessage('status', '✓ Session selected. Click "Select Element" on any page to resume your conversation.');

      // Keep the selection in dropdown
      return;
    }

    currentSessionId = response.sessionId;
    console.log('[UI CHATTER] Switching from session:', currentSessionId);

    try {
      // Call switch API
      const response = await fetch(
        `http://localhost:3456/api/v1/sessions/${currentSessionId}/switch-sdk-session`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target_sdk_session_id: targetSdkSessionId })
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to switch: ${response.statusText}`);
      }

      const result = await response.json();
      currentSdkSessionId = result.sdk_session_id;

      console.log('[UI CHATTER] Switch successful, new SDK session:', currentSdkSessionId);

      // Load chat history for the resumed session
      await loadChatHistory(currentSessionId);

      // Show success message
      addMessage('status', `✓ Resumed previous conversation`);

      // Show badge
      elements.sessionBadge.style.display = 'inline-block';

    } catch (error) {
      console.error('[UI CHATTER] Error switching SDK session:', error);
      addMessage('error', `Failed to resume: ${error.message}`);

      // Reset dropdown
      event.target.value = '';
    }
  });
}

// Handle tab switch - refresh connection and UI for new tab
async function handleTabSwitch(message) {
  const { tabId, pageUrl, connection } = message;

  console.log('[UI CHATTER] Tab switched to:', tabId, pageUrl);

  // Update current tab ID
  currentTabId = tabId;

  // Update tab indicator
  updateTabIndicator(tabId, pageUrl);

  // Clear current messages
  clearMessages();

  // Check if the new tab has an existing connection/session
  if (connection && connection.sessionId) {
    // Tab has existing session - reconnect and load history
    console.log('[UI CHATTER] Tab has existing session:', connection.sessionId, connection);

    currentSessionId = connection.sessionId;
    currentSdkSessionId = connection.sdkSessionId;

    // Request connection to this tab
    await connectToCurrentTab();

    // Load chat history
    console.log('[UI CHATTER] About to load history for session:', currentSessionId);
    await loadChatHistory(currentSessionId);
    console.log('[UI CHATTER] History load complete, DOM has', elements.messages.children.length, 'elements');

    // Only add status message if no history was loaded
    if (elements.messages.children.length === 0) {
      addMessage('status', `✓ Switched to conversation for this tab (no messages yet)`);
    }
  } else {
    // Tab has no session yet - show blank state
    console.log('[UI CHATTER] New tab, no existing conversation');

    currentSessionId = null;
    currentSdkSessionId = null;

    // Request connection to this tab (will create new session)
    await connectToCurrentTab();

    addMessage('status', 'No conversation for this tab yet. Select an element to start chatting.');
  }

  // Reset session selector
  if (elements.sdkSessionSelect) {
    elements.sdkSessionSelect.value = '';
  }

  // Refresh available sessions
  fetchSdkSessions();
}

// Connect to the current tab's WebSocket
async function connectToCurrentTab() {
  if (!currentTabId) {
    console.warn('[UI CHATTER] No current tab ID');
    return;
  }

  try {
    // Get current tab info
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (!tab) return;

    // Request connection from background worker
    chrome.runtime.sendMessage({
      type: 'connect_tab',
      tabId: tab.id,
      pageUrl: tab.url
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('[UI CHATTER] Error connecting:', chrome.runtime.lastError);
        return;
      }

      if (response?.success) {
        console.log('[UI CHATTER] Connected to tab:', tab.id);
        updateConnectionStatus(true);
      } else {
        console.error('[UI CHATTER] Connection failed:', response?.error);
        updateConnectionStatus(false);
      }
    });
  } catch (err) {
    console.error('[UI CHATTER] Error in connectToCurrentTab:', err);
  }
}

function updateTabIndicator(tabId, pageUrl) {
  if (!elements.tabIndicator || !elements.tabIndicatorText) return;

  try {
    // Show tab indicator
    elements.tabIndicator.style.display = 'flex';

    // Parse and display page info
    const url = new URL(pageUrl);
    const displayText = `${url.hostname}${url.pathname}`;
    elements.tabIndicatorText.textContent = `Viewing: ${displayText}`;
  } catch (err) {
    // Invalid URL, just show tab ID
    elements.tabIndicatorText.textContent = `Viewing: Tab ${tabId}`;
  }
}

async function handleTabUrlChange(message) {
  const { tabId, pageUrl, sessionId } = message;

  console.log('[UI CHATTER] Tab URL changed:', tabId, pageUrl);

  // If we're currently viewing this tab, update context
  if (tabId === currentTabId) {
    // Optionally show notification about URL change
    addMessage('status', `Page navigated to: ${new URL(pageUrl).pathname}`);
  }
}

function clearMessages() {
  // Clear all messages except system status
  elements.messages.innerHTML = '';

  // Reset assistant message tracking
  lastAssistantMessage = null;
}

async function switchToSdkSession(targetSdkSessionId) {
  if (!currentSessionId) {
    console.warn('[UI CHATTER] No active WebSocket session');
    return;
  }

  try {
    // Call backend to switch SDK session
    const response = await fetch(
      `http://localhost:3456/api/v1/sessions/${currentSessionId}/switch-sdk-session`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_sdk_session_id: targetSdkSessionId })
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to switch: ${response.statusText}`);
    }

    const result = await response.json();
    currentSdkSessionId = result.sdk_session_id;

    console.log('[UI CHATTER] Switched to SDK session:', currentSdkSessionId);

    // Load chat history for this session
    await loadChatHistory(currentSessionId);

    // Update session selector dropdown
    if (elements.sdkSessionSelect) {
      elements.sdkSessionSelect.value = targetSdkSessionId;
    }

    // Show session badge
    elements.sessionBadge.style.display = 'inline-block';

  } catch (error) {
    console.error('[UI CHATTER] Error switching SDK session:', error);
    addMessage('error', `Failed to switch conversation: ${error.message}`);
  }
}

// Handle element selection
function handleElementCaptured(context) {
  currentContext = context;
  const el = context.element;

  // Show selected element
  elements.selectedElement.classList.add('visible');
  elements.elementTag.textContent = `<${el.tagName}${el.id ? ` id="${el.id}"` : ''}${el.classList.length ? ` class="${el.classList.join(' ')}"` : ''}>`;

  // Focus input (always enabled now)
  elements.messageInput.focus();

  // Add message
  addMessage('status', `Element selected: ${el.tagName}`);
}

// Handle server messages - multi-channel protocol
function handleServerMessage(message) {
  const { type } = message;

  switch(type) {
    case 'handshake_ack':
      // Handle handshake acknowledgment with auto-resume notification
      currentSessionId = message.session_id;
      console.log('[UI CHATTER] Handshake acknowledged, session:', currentSessionId);

      // Get current tab and register this session
      chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
        if (tabs.length > 0) {
          const tab = tabs[0];
          currentTabId = tab.id;

          // Register tab-to-session mapping in background
          chrome.runtime.sendMessage({
            type: 'register_tab_session',
            tabId: tab.id,
            sessionId: currentSessionId,
            sdkSessionId: message.sdk_session_id || null,  // May be set on resume
            pageUrl: tab.url
          });
        }
      });

      if (message.resumed) {
        // Session was auto-resumed
        addMessage('status', '✓ Resumed previous conversation for this page');

        // Load chat history
        loadChatHistory(currentSessionId);

        // Show badge
        elements.sessionBadge.style.display = 'inline-block';
      }
      break;

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

    case 'permission_request':
      handlePermissionRequest(message);
      break;

    case 'session_cleared':
      // Handle session cleared - clear UI and update session ID
      currentSdkSessionId = message.sdk_session_id;

      // Clear all messages
      elements.messages.innerHTML = '';

      // Add confirmation message
      addMessage('status', '✨ ' + (message.message || 'New conversation started'));

      // Hide session badge (no longer resuming)
      if (elements.sessionBadge) {
        elements.sessionBadge.style.display = 'none';
      }

      // Reset session dropdown to show new session
      if (elements.sdkSessionSelect) {
        elements.sdkSessionSelect.value = '';
      }

      // Refresh available sessions list
      if (currentSessionId) {
        fetchAvailableSessions(currentSessionId);
      }

      // Update SDK session ID in background
      if (currentTabId) {
        chrome.runtime.sendMessage({
          type: 'update_sdk_session_id',
          tabId: currentTabId,
          sdkSessionId: message.sdk_session_id
        });
      }

      console.log('[UI CHATTER] Session cleared, new SDK session:', message.sdk_session_id);
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

      // After stream completes, check if SDK session was established
      // (for first message in a conversation)
      if (!currentSdkSessionId && currentSessionId) {
        updateSdkSessionFromBackend();
      }
      break;

    case 'cancelled':
      hideStreamingUI();
      addMessage('status', '⏹ Request cancelled');
      break;
  }
}

// Query backend for current SDK session ID and update tab mapping
async function updateSdkSessionFromBackend() {
  if (!currentSessionId) return;

  try {
    const response = await fetch(`http://localhost:3456/sessions`);
    if (!response.ok) return;

    const data = await response.json();
    const sessions = data.sessions || [];

    // Find our current session
    const session = sessions.find(s => s.session_id === currentSessionId);
    if (!session) return;

    const sdkSessionId = session.sdk_session_id;

    if (sdkSessionId && sdkSessionId !== currentSdkSessionId) {
      currentSdkSessionId = sdkSessionId;
      console.log('[UI CHATTER] SDK session established:', currentSdkSessionId);

      // Update background worker's connection object with SDK session ID
      if (currentTabId) {
        chrome.runtime.sendMessage({
          type: 'update_sdk_session_id',
          tabId: currentTabId,
          sdkSessionId: currentSdkSessionId
        }, (response) => {
          if (response?.success) {
            console.log('[UI CHATTER] Background worker updated with SDK session ID');
          } else {
            console.error('[UI CHATTER] Failed to update SDK session ID in background');
          }
        });
      }
    }
  } catch (error) {
    console.error('[UI CHATTER] Error fetching SDK session:', error);
  }
}

function handleResponseChunk(message) {
  const { content, done } = message;

  console.log('[CHUNK]', { done: message.done, contentLength: message.content?.length });

  // Create message container if needed (BEFORE checking done flag)
  if (!lastAssistantMessage || lastAssistantMessage.className !== 'message assistant') {
    lastAssistantMessage = addMessage('assistant', '');
    lastAssistantMessage.dataset.rawContent = '';
  }

  if (done) {
    // Final render with markdown
    if (lastAssistantMessage && lastAssistantMessage.dataset.rawContent) {
      console.log('Rendering markdown for completed response');
      renderMarkdown(lastAssistantMessage);
    }
    return;
  }

  // Accumulate raw content
  lastAssistantMessage.dataset.rawContent += content;

  // For streaming, show plain text (will be replaced with markdown when done)
  lastAssistantMessage.textContent = lastAssistantMessage.dataset.rawContent;

  elements.messages.scrollTop = elements.messages.scrollHeight;
}

// Render markdown content with syntax highlighting
function renderMarkdown(messageElement) {
  const rawContent = messageElement.dataset.rawContent;
  if (!rawContent) return;

  console.log('[MARKDOWN] Starting render, content length:', rawContent.length);

  // Check if libraries are loaded
  if (!librariesLoaded || typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
    console.warn('Markdown libraries not loaded, showing plain text');
    messageElement.textContent = rawContent;
    return;
  }

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
      ALLOWED_ATTR: ['href', 'class', 'language-*'],
      ALLOW_DATA_ATTR: false
    });

    // Set HTML
    messageElement.innerHTML = sanitized;

    // Apply syntax highlighting if Prism is available
    if (typeof Prism !== 'undefined') {
      messageElement.querySelectorAll('pre code').forEach(block => {
        try {
          Prism.highlightElement(block);
        } catch (err) {
          console.warn('Prism highlighting failed:', err);
        }
      });
    }

    console.log('[MARKDOWN] Render complete');
    elements.messages.scrollTop = elements.messages.scrollHeight;
  } catch (err) {
    console.error('Error rendering markdown:', err);
    // Fallback to plain text
    messageElement.textContent = rawContent;
    // Show user-visible error
    addMessage('error', 'Failed to render markdown. Showing plain text.');
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

/**
 * Command Autocomplete Controller
 */
const AutocompleteController = {
  dropdown: null,
  listElement: null,
  inputElement: null,
  selectedIndex: -1,
  suggestions: [],
  currentPrefix: '',
  isVisible: false,
  abortController: null,

  init() {
    this.dropdown = document.getElementById('autocompleteDropdown');
    this.listElement = document.getElementById('autocompleteList');
    this.inputElement = elements.messageInput;

    if (!this.dropdown || !this.listElement || !this.inputElement) {
      console.error('[AUTOCOMPLETE] Required DOM elements not found');
      return;
    }

    this.inputElement.addEventListener('input', (e) => this.handleInput(e));
    this.inputElement.addEventListener('keydown', (e) => this.handleKeydown(e));

    document.addEventListener('click', (e) => {
      if (!this.dropdown.contains(e.target) && e.target !== this.inputElement) {
        this.hide();
      }
    });

    this.inputElement.addEventListener('blur', (e) => {
      setTimeout(() => {
        if (!this.dropdown.contains(document.activeElement)) {
          this.hide();
        }
      }, 150);
    });

    console.log('[AUTOCOMPLETE] Controller initialized');
  },

  async handleInput(e) {
    const input = e.target.value;
    const cursorPos = e.target.selectionStart;
    const textBeforeCursor = input.substring(0, cursorPos);
    // Match slash commands including colons, hyphens, and underscores
    // Examples: /commit, /my-plugin:command, /product-design:parallel-run
    // Use \- to escape hyphen for safety
    const slashMatch = textBeforeCursor.match(/\/([\w:\-]*)$/);

    console.log('[AUTOCOMPLETE] Input event:', { input, cursorPos, textBeforeCursor, slashMatch });

    if (slashMatch) {
      const prefix = '/' + slashMatch[1];
      console.log('[AUTOCOMPLETE] Slash detected, prefix:', prefix);
      if (prefix !== this.currentPrefix) {
        this.currentPrefix = prefix;
        await this.fetchSuggestions(prefix);
      }
    } else {
      this.hide();
    }
  },

  async fetchSuggestions(prefix) {
    console.log('[AUTOCOMPLETE] fetchSuggestions called with prefix:', prefix);
    console.log('[AUTOCOMPLETE] currentSessionId:', currentSessionId);

    if (!currentSessionId) {
      console.warn('[AUTOCOMPLETE] No active session - hiding autocomplete');
      this.suggestions = [];
      this.hide();
      return;
    }

    if (this.abortController) {
      this.abortController.abort();
    }
    this.abortController = new AbortController();

    try {
      const url = `http://localhost:3456/api/v1/projects/${currentSessionId}/commands?mode=agent&prefix=${encodeURIComponent(prefix)}&limit=20`;
      console.log('[AUTOCOMPLETE] Fetching from:', url);
      const response = await fetch(url, { signal: this.abortController.signal });

      console.log('[AUTOCOMPLETE] Response status:', response.status);

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const data = await response.json();
      console.log('[AUTOCOMPLETE] Received data:', data);
      this.suggestions = data.commands || [];
      console.log('[AUTOCOMPLETE] Suggestions:', this.suggestions);
      this.render();

    } catch (error) {
      if (error.name === 'AbortError') return;
      console.error('[AUTOCOMPLETE] Failed to fetch:', error);
      this.hide();
    }
  },

  render() {
    console.log('[AUTOCOMPLETE] render() called, suggestions count:', this.suggestions.length);
    this.listElement.innerHTML = '';

    if (this.suggestions.length === 0) {
      this.listElement.innerHTML = '<div class="autocomplete-empty">No matching commands found</div>';
      this.show();
      return;
    }

    this.suggestions.forEach((cmd, index) => {
      const item = document.createElement('div');
      item.className = 'autocomplete-item';
      item.dataset.index = index;

      const nameEl = document.createElement('div');
      nameEl.className = 'command-name';
      nameEl.textContent = cmd.command;
      item.appendChild(nameEl);

      if (cmd.description) {
        const descEl = document.createElement('div');
        descEl.className = 'command-description';
        descEl.textContent = cmd.description;
        item.appendChild(descEl);
      }

      item.addEventListener('click', () => this.selectSuggestion(index));
      this.listElement.appendChild(item);
    });

    this.selectedIndex = -1;
    this.show();
  },

  handleKeydown(e) {
    if (!this.isVisible) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.moveSelection(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.moveSelection(-1);
        break;
      case 'Enter':
        if (this.selectedIndex >= 0) {
          e.preventDefault();
          this.selectSuggestion(this.selectedIndex);
        }
        break;
      case 'Tab':
        if (this.selectedIndex >= 0) {
          e.preventDefault();
          this.selectSuggestion(this.selectedIndex);
        } else if (this.suggestions.length > 0) {
          e.preventDefault();
          this.selectSuggestion(0);
        }
        break;
      case 'Escape':
        e.preventDefault();
        this.hide();
        break;
    }
  },

  moveSelection(delta) {
    const items = this.listElement.querySelectorAll('.autocomplete-item');
    if (items.length === 0) return;

    if (this.selectedIndex >= 0 && this.selectedIndex < items.length) {
      items[this.selectedIndex].classList.remove('selected');
    }

    this.selectedIndex += delta;

    if (this.selectedIndex < 0) {
      this.selectedIndex = items.length - 1;
    } else if (this.selectedIndex >= items.length) {
      this.selectedIndex = 0;
    }

    items[this.selectedIndex].classList.add('selected');
    items[this.selectedIndex].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  },

  selectSuggestion(index) {
    if (index < 0 || index >= this.suggestions.length) return;

    const selected = this.suggestions[index];
    const input = this.inputElement;
    const currentValue = input.value;
    const cursorPos = input.selectionStart;
    const beforeCursor = currentValue.substring(0, cursorPos);
    const afterCursor = currentValue.substring(cursorPos);
    const slashMatch = beforeCursor.match(/\/(\w*)$/);

    if (!slashMatch) return;

    const startPos = cursorPos - slashMatch[0].length;
    const newValue = currentValue.substring(0, startPos) + selected.command + ' ' + afterCursor;

    input.value = newValue;
    const newCursorPos = startPos + selected.command.length + 1;
    input.setSelectionRange(newCursorPos, newCursorPos);

    this.hide();
    input.focus();

    console.log('[AUTOCOMPLETE] Inserted:', selected.command);
  },

  show() {
    console.log('[AUTOCOMPLETE] show() called');
    const inputRect = this.inputElement.getBoundingClientRect();
    console.log('[AUTOCOMPLETE] Input rect:', inputRect);

    // Position above the input box
    const dropdownHeight = Math.min(400, this.suggestions.length * 60); // Estimate height
    this.dropdown.style.bottom = `${window.innerHeight - inputRect.top + 4}px`;
    this.dropdown.style.top = 'auto';
    this.dropdown.style.left = `${inputRect.left}px`;
    this.dropdown.style.width = `${Math.max(inputRect.width, 300)}px`;
    this.dropdown.style.display = 'block';

    console.log('[AUTOCOMPLETE] Dropdown positioned above input');
    this.isVisible = true;
  },

  hide() {
    this.dropdown.style.display = 'none';
    this.suggestions = [];
    this.selectedIndex = -1;
    this.currentPrefix = '';
    this.isVisible = false;

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }
};

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
  if (!message) return;

  // Check for /clear command
  if (message === '/clear') {
    // Clear input immediately
    elements.messageInput.value = '';

    // Show clearing message
    addMessage('status', 'Clearing conversation and starting new session...');

    // Send clear session request to backend
    chrome.runtime.sendMessage({
      type: 'clear_session'
    });

    return;
  }

  // Add user message to chat
  addMessage('user', message);

  // Clear input
  elements.messageInput.value = '';

  // Reset last assistant message
  lastAssistantMessage = null;

  // Send to background script (context is optional)
  chrome.runtime.sendMessage({
    type: 'send_chat',
    context: currentContext || null,
    message
  });
}

elements.sendBtn.addEventListener('click', sendMessage);
elements.stopBtn.addEventListener('click', () => {
  console.log('[UI CHATTER] Stop button clicked, stream_id:', currentStreamId);
  cancelStream();
});
elements.messageInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') sendMessage();
});

// Initialize: connect to current tab
(async function initializeSidePanel() {
  console.log('[UI CHATTER] Side panel initializing...');

  // Ensure the sidepanel has focus for keyboard shortcuts
  window.focus();

  // Add visual hint that input needs activation
  const input = document.getElementById('messageInput');
  if (input) {
    input.classList.add('needs-activation');
  }

  // Auto-focus chat input for immediate typing (aggressive strategy)
  const focusInput = () => {
    const input = document.getElementById('messageInput');
    if (input) {
      input.focus();
      const focused = document.activeElement === input;
      console.log('[FOCUS] Attempted focus, successful:', focused, 'activeElement:', document.activeElement?.id || document.activeElement?.tagName);
      return focused;
    } else {
      console.warn('[FOCUS] Input element not found');
      return false;
    }
  };

  // Try blur-then-focus trick (sometimes helps)
  const blurThenFocus = () => {
    const input = document.getElementById('messageInput');
    if (input) {
      input.blur();
      setTimeout(() => input.focus(), 0);
    }
  };

  // Try multiple times with different strategies
  focusInput(); // Immediate
  setTimeout(focusInput, 10);
  setTimeout(blurThenFocus, 20); // Try blur-focus trick
  setTimeout(focusInput, 50);
  setTimeout(focusInput, 100);
  setTimeout(focusInput, 200);
  setTimeout(focusInput, 500);
  setTimeout(focusInput, 1000); // One more at 1s

  // Use requestAnimationFrame for next render cycle
  requestAnimationFrame(() => {
    focusInput();
    requestAnimationFrame(focusInput);
  });

  // Focus on any interaction with the panel
  document.addEventListener('mouseenter', focusInput, { once: false });

  // One-time click anywhere to activate and focus input
  let hasActivated = false;
  document.addEventListener('click', (e) => {
    if (!hasActivated) {
      hasActivated = true;
      focusInput();
      // Remove visual hint and update placeholder
      const input = document.getElementById('messageInput');
      if (input) {
        input.classList.remove('needs-activation');
        if (input.placeholder === 'Click here to start typing...') {
          input.placeholder = 'Type your message...';
        }
      }
      console.log('[FOCUS] Panel activated on first click');
    }
    // Don't steal focus if user clicked a button or input
    if (!e.target.matches('button, input, select, textarea, a')) {
      focusInput();
    }
  }, { capture: true }); // Use capture to catch clicks early

  // Also try to focus when window gains focus
  window.addEventListener('focus', () => {
    console.log('[FOCUS] Window gained focus');
    setTimeout(focusInput, 10);
    setTimeout(focusInput, 50);
  });

  try {
    // Get current tab
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (!tab) {
      console.error('[UI CHATTER] No active tab found');
      return;
    }

    currentTabId = tab.id;
    updateTabIndicator(tab.id, tab.url);

    // Get connection info from background
    const response = await chrome.runtime.sendMessage({
      type: 'get_tab_connection',
      tabId: tab.id
    });

    console.log('[UI CHATTER] Tab connection info:', response);

    // If tab has existing session, load history
    if (response.connection && response.connection.sessionId) {
      console.log('[UI CHATTER] Found existing session:', response.connection.sessionId);

      currentSessionId = response.connection.sessionId;
      currentSdkSessionId = response.connection.sdkSessionId;

      // Connect to this tab's WebSocket
      await connectToCurrentTab();

      // Load chat history
      await loadChatHistory(currentSessionId);

      console.log('[UI CHATTER] History loaded, messages:', elements.messages.children.length);
    } else {
      console.log('[UI CHATTER] No existing session for this tab');

      // Connect to tab (will create new session)
      await connectToCurrentTab();

      addMessage('status', 'No conversation for this tab yet. Select an element to start chatting.');
    }

    console.log('[UI CHATTER] Initialized for tab:', tab.id);
  } catch (err) {
    console.error('[UI CHATTER] Error during initialization:', err);
  }
})();

// Initialize autocomplete
(function() {
  console.log('[AUTOCOMPLETE] Initializing...');
  AutocompleteController.init();
})();

// Initialize permission mode selector
(async function initializePermissionMode() {
  console.log('[PERMISSION MODE] Initializing...');

  // Load current permission mode from storage
  const result = await chrome.storage.local.get(['permissionMode']);
  const currentMode = result.permissionMode || 'plan';

  // Set the select value
  if (elements.permissionModeSelect) {
    elements.permissionModeSelect.value = currentMode;
    console.log('[PERMISSION MODE] Loaded:', currentMode);
  }

  // Listen for mode changes
  elements.permissionModeSelect.addEventListener('change', async (e) => {
    const newMode = e.target.value;
    console.log('[PERMISSION MODE] Changed to:', newMode);

    // Save to storage
    await chrome.storage.local.set({ permissionMode: newMode });

    // Notify background script to update server
    chrome.runtime.sendMessage({
      type: 'permission_mode_changed',
      mode: newMode
    });

    // Show confirmation
    addMessage('status', `Conversation mode changed to: ${getModeLabel(newMode)}`);
  });
})();

// Helper function to get mode label
function getModeLabel(mode) {
  const labels = {
    'plan': 'Planning',
    'bypassPermissions': 'Fast',
    'acceptEdits': 'Balanced'
  };
  return labels[mode] || mode;
}

// Shift+Tab to cycle through permission modes
document.addEventListener('keydown', (e) => {
  // Check for Shift+Tab
  if (e.shiftKey && e.key === 'Tab') {
    // Don't interfere with permission modal
    if (currentPermissionRequest || document.getElementById('permissionModal')?.style.display === 'block') {
      return;
    }

    // Make sure element exists
    const modeSelect = document.getElementById('permissionModeSelect');
    if (!modeSelect) {
      console.warn('[PERMISSION MODE] Select element not found');
      return;
    }

    e.preventDefault();

    const modes = ['plan', 'bypassPermissions', 'acceptEdits'];
    const currentIndex = modes.indexOf(modeSelect.value);
    const nextIndex = (currentIndex + 1) % modes.length;

    modeSelect.value = modes[nextIndex];
    modeSelect.dispatchEvent(new Event('change'));

    console.log('[PERMISSION MODE] Cycled to:', modes[nextIndex]);
  }
});

// Check markdown libraries on load
window.addEventListener('load', () => {
  if (!checkLibraries()) {
    console.error('❌ Markdown libraries failed to load');
    addMessage('error', 'Markdown rendering unavailable - libraries failed to load');
  }
});

// ===== Permission Support =====

function handlePermissionRequest(message) {
  const {
    request_id,
    request_type,
    tool_name,
    input_data,
    questions,
    timeout_seconds
  } = message;

  currentPermissionRequest = { request_id, request_type };

  if (request_type === 'ask_user_question') {
    showAskUserQuestion(questions, timeout_seconds || 60);
  } else {
    showToolPermission(tool_name, input_data, timeout_seconds || 60);
  }
}

function showToolPermission(toolName, inputData, timeoutSeconds) {
  // Show tool approval UI, hide question UI
  document.getElementById('toolApprovalContent').style.display = 'block';
  document.getElementById('questionContainer').style.display = 'none';

  // Populate tool details
  document.getElementById('permissionToolName').textContent = toolName;
  document.getElementById('permissionToolInput').textContent =
    formatToolInput(toolName, inputData);

  // Show modal
  document.getElementById('permissionModal').style.display = 'block';

  // Start countdown timer (58s client-side, 60s server-side)
  startPermissionTimer(Math.max(58, timeoutSeconds - 2));

  // Focus allow button for keyboard accessibility
  document.getElementById('allowBtn').focus();
}

function formatToolInput(toolName, input) {
  // Tool-specific formatting for better readability
  if (toolName === 'Bash') {
    const cmd = input.command || '';
    const desc = input.description || '';

    // Highlight dangerous patterns
    let formatted = `$ ${cmd}`;
    if (cmd.includes('rm ') || cmd.includes('sudo') || cmd.includes('--force')) {
      formatted = `⚠️ DANGER: ${formatted}`;
    }

    if (desc) {
      formatted += `\n\n${desc}`;
    }

    return formatted;
  } else if (toolName === 'Write') {
    const path = input.file_path || '';
    const content = input.content || '';
    const preview = content.substring(0, 200);
    return `File: ${path}\n\nContent preview:\n${preview}${
      content.length > 200 ? '...' : ''
    }`;
  } else if (toolName === 'Edit') {
    return `File: ${input.file_path}\n\nOld: ${input.old_string}\nNew: ${input.new_string}`;
  } else if (toolName === 'Read') {
    return `File: ${input.file_path}${
      input.offset ? `\nOffset: ${input.offset}` : ''
    }${input.limit ? `\nLimit: ${input.limit} lines` : ''}`;
  } else {
    return JSON.stringify(input, null, 2);
  }
}

function startPermissionTimer(seconds) {
  let remaining = seconds;
  const timerEl = document.getElementById('permissionTimer');

  permissionTimer = setInterval(() => {
    remaining--;
    timerEl.textContent = `${remaining}s`;

    // Visual warning when time is running out
    if (remaining <= 10) {
      timerEl.classList.add('warning');
    }

    if (remaining === 0) {
      clearInterval(permissionTimer);
      // Auto-deny on timeout
      respondToPermission(false, null);
    }
  }, 1000);
}

function respondToPermission(approved, modifiedInput = null, answers = null) {
  clearInterval(permissionTimer);

  // Send response via background script
  chrome.runtime.sendMessage({
    type: 'sendToServer',
    data: {
      type: 'permission_response',
      request_id: currentPermissionRequest.request_id,
      approved,
      modified_input: modifiedInput,
      answers: answers,
      reason: approved ? null : 'User denied'
    }
  });

  // Hide modal
  document.getElementById('permissionModal').style.display = 'none';
  document.getElementById('permissionTimer').classList.remove('warning');
  currentPermissionRequest = null;
}

function showAskUserQuestion(questions, timeoutSeconds) {
  // Hide tool UI, show question UI
  document.getElementById('toolApprovalContent').style.display = 'none';
  document.getElementById('questionContainer').style.display = 'block';

  const container = document.getElementById('questionContainer');
  container.innerHTML = '';

  // Store questions for later retrieval
  currentPermissionRequest.questions = questions;

  questions.forEach((q, index) => {
    const questionDiv = document.createElement('div');
    questionDiv.className = 'question-block';

    const header = document.createElement('h4');
    header.textContent = q.header || q.question;
    questionDiv.appendChild(header);

    const paragraph = document.createElement('p');
    paragraph.textContent = q.question;
    paragraph.className = 'question-text';
    questionDiv.appendChild(paragraph);

    q.options.forEach(opt => {
      const label = document.createElement('label');
      label.className = 'option-label';

      const input = document.createElement('input');
      input.type = q.multiSelect ? 'checkbox' : 'radio';
      input.name = `question-${index}`;
      input.value = opt.label;
      input.className = 'option-input';

      label.appendChild(input);

      const optionText = document.createElement('div');
      optionText.className = 'option-text';

      const optionLabel = document.createElement('div');
      optionLabel.className = 'option-label-text';
      optionLabel.textContent = opt.label;
      optionText.appendChild(optionLabel);

      if (opt.description) {
        const desc = document.createElement('div');
        desc.className = 'option-description';
        desc.textContent = opt.description;
        optionText.appendChild(desc);
      }

      label.appendChild(optionText);
      questionDiv.appendChild(label);
    });

    container.appendChild(questionDiv);
  });

  document.getElementById('permissionModal').style.display = 'block';
  startPermissionTimer(Math.max(58, timeoutSeconds - 2));
}

function collectQuestionAnswers() {
  const questions = currentPermissionRequest.questions;
  const answers = {};

  questions.forEach((q, index) => {
    const inputs = document.querySelectorAll(
      `input[name="question-${index}"]:checked`
    );

    if (q.multiSelect) {
      // Multi-select: join labels with ", "
      answers[q.question] = Array.from(inputs)
        .map(i => i.value)
        .join(', ');
    } else {
      // Single select: just the label
      answers[q.question] = inputs[0]?.value || '';
    }
  });

  return answers;
}

// Event listeners for permission modal
document.getElementById('allowBtn').addEventListener('click', () => {
  if (currentPermissionRequest.request_type === 'ask_user_question') {
    const answers = collectQuestionAnswers();
    respondToPermission(true, null, answers);
  } else {
    respondToPermission(true, null, null);
  }
});

document.getElementById('denyBtn').addEventListener('click', () => {
  respondToPermission(false, null, null);
});

// Keyboard shortcuts for permission modal
document.addEventListener('keydown', e => {
  if (!currentPermissionRequest) return;

  if (e.key === 'Enter') {
    e.preventDefault();
    if (currentPermissionRequest.request_type === 'ask_user_question') {
      const answers = collectQuestionAnswers();
      respondToPermission(true, null, answers);
    } else {
      respondToPermission(true, null, null);
    }
  } else if (e.key === 'Escape') {
    e.preventDefault();
    respondToPermission(false, null, null);
  }
});

// ===== End Permission Support =====

// Extension lifecycle logging
console.log('[UI CHATTER] Side panel loaded');
console.log('[UI CHATTER] Timestamp:', new Date().toISOString());

// Log when panel becomes visible and ensure focus
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    console.log('[UI CHATTER] Panel hidden/minimized');
  } else {
    console.log('[UI CHATTER] Panel visible/opened');
    console.log('[UI CHATTER] Current state:', {
      isConnected,
      currentSessionId,
      currentSdkSessionId,
      hasContext: !!currentContext
    });

    // Ensure focus when panel becomes visible
    window.focus();

    // Auto-focus chat input for immediate typing (multiple attempts)
    const focusOnVisible = () => {
      const input = document.getElementById('messageInput');
      if (input) {
        input.blur(); // Try blur first
        setTimeout(() => {
          input.focus();
          const focused = document.activeElement === input;
          console.log('[FOCUS] Visibility change focus attempt, successful:', focused);
        }, 0);
      }
    };

    // Try multiple times
    focusOnVisible();
    setTimeout(focusOnVisible, 10);
    setTimeout(focusOnVisible, 50);
    setTimeout(focusOnVisible, 100);
    setTimeout(focusOnVisible, 200);
    setTimeout(focusOnVisible, 500);
    requestAnimationFrame(focusOnVisible);
  }
});

console.log('Side panel loaded');
export {};
