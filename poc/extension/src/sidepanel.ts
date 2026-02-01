// Side panel script
import type {
  ServerMessage,
  PermissionMode,
  HandshakeAckMessage,
  CapturedElement,
  BackgroundToSidepanelMessage,
  StreamControlMessage,
  ToolActivityMessage
} from './types.js';
import { InputHistoryController } from './inputhistory.js';
import { AutocompleteController } from './autocomplete.js';
import { PermissionModeController } from './PermissionModeController.js';

// Type definitions
interface SdkSession {
  sdk_session_id: string;
  title: string;
  status: string;
  created_at: string;
  last_activity: string;
}

interface ToolActivity {
  name: string;
  status: string;
  input_summary: string;
  input?: Record<string, unknown>;  // Full input data
  output_summary?: string;  // Output summary
  output?: unknown;  // Full output data
  duration_ms?: number;
  duration?: number;
  timestamp?: number;
}

interface ChatMessage {
  role: string;
  content: string | Array<{ type: string; text: string }>;
  timestamp: string;
}

interface Elements {
  statusIndicator: HTMLElement | null;
  statusText: HTMLElement | null;
  selectedElement: HTMLElement | null;
  permissionModeSelect: HTMLSelectElement | null;
  elementTag: HTMLElement | null;
  messages: HTMLElement | null;
  messageInput: HTMLTextAreaElement | null;
  sendBtn: HTMLButtonElement | null;
  selectBtn: HTMLButtonElement | null;
  stopBtn: HTMLButtonElement | null;
  thinkingIndicator: HTMLElement | null;
  sessionSelector: HTMLElement | null;
  sdkSessionSelect: HTMLSelectElement | null;
  sessionBadge: HTMLElement | null;
  tabIndicator: HTMLElement | null;
  tabIndicatorText: HTMLElement | null;
}

// State variables
let currentContext: CapturedElement | null = null;
let isConnected: boolean = false;
let currentSessionId: string | null = null;  // WebSocket session ID
let currentSdkSessionId: string | null = null;  // Agent SDK session ID
let selectedSdkSessionId: string | null = null;  // User's selected SDK session (before connection)

// Tab tracking for per-tab connections
let currentTabId: number | null = null;  // Browser tab ID currently being displayed

// Multi-channel streaming state
const MessageType = {
  RESPONSE_CHUNK: 'response_chunk',
  THINKING: 'thinking',
  TOOL_ACTIVITY: 'tool_activity',
  STREAM_CONTROL: 'stream_control',
  STATUS: 'status',
  ERROR: 'error'
} as const;

const ToolActivityStatus = {
  PENDING: 'pending',
  EXECUTING: 'executing',
  COMPLETED: 'completed',
  FAILED: 'failed'
} as const;

// Chrome runtime message types (for chrome.runtime.sendMessage)
const RuntimeMessageType = {
  SEND_CHAT: 'send_chat',
  SEND_TO_SERVER: 'sendToServer',
  PERMISSION_MODE_CHANGED: 'permission_mode_changed'
} as const;

// Extract literal types from constants
type MessageTypeValue = typeof MessageType[keyof typeof MessageType];
type ToolActivityStatusValue = typeof ToolActivityStatus[keyof typeof ToolActivityStatus];
type RuntimeMessageTypeValue = typeof RuntimeMessageType[keyof typeof RuntimeMessageType];

// Runtime message type definitions (chrome.runtime.sendMessage)
interface SendChatMessage {
  type: typeof RuntimeMessageType.SEND_CHAT;
  elementContext: CapturedElement | null;
  message: string;
}

interface SendToServerMessage {
  type: typeof RuntimeMessageType.SEND_TO_SERVER;
  data: {
    type: string;
    [key: string]: any;
  };
}

interface PermissionModeChangedMessage {
  type: typeof RuntimeMessageType.PERMISSION_MODE_CHANGED;
  mode: string;
}

// Union type for all runtime messages
type RuntimeMessage = SendChatMessage | SendToServerMessage | PermissionModeChangedMessage;

// Typed helper for sending runtime messages (provides compile-time type checking)
function sendRuntimeMessage(message: RuntimeMessage): void {
  chrome.runtime.sendMessage(message);
}

// Active tools tracking
const activeTools: Map<string, ToolActivity> = new Map();
let activeToolPanel: HTMLElement | null = null;
let currentStreamId: string | null = null;

// Permission modal state
let currentPermissionRequest: {
  tool_name: string;
  input_data: unknown;
  request_id?: string;
  request_type?: string;
  plan?: string | null;
  questions?: Array<{ question: string; header: string; options: Array<{ label: string; description: string }>; multiSelect: boolean }>;
} | null = null;
let permissionTimer: ReturnType<typeof setTimeout> | null = null;

// Extend window interface for markdown library
declare global {
  interface Window {
    marked?: {
      parse: (markdown: string) => string;
    };
  }
}

// Markdown library load state
let librariesLoaded: boolean = false;
let domPurifyConfigured: boolean = false;

// Check if markdown libraries are available
function checkLibraries(): boolean {
  if (typeof marked !== 'undefined' &&
      typeof DOMPurify !== 'undefined' &&
      typeof Prism !== 'undefined') {
    librariesLoaded = true;

    // Configure DOMPurify once when libraries are loaded
    if (!domPurifyConfigured) {
      DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
        if (data.attrName === 'class') {
          // Allow all class attributes - they're safe and needed for syntax highlighting
          return;
        }
      });
      domPurifyConfigured = true;
      console.log('✓ DOMPurify configured for syntax highlighting');
    }

    console.log('✓ Markdown libraries loaded');
    return true;
  }
  return false;
}

const elements: Elements = {
  statusIndicator: document.getElementById('statusIndicator'),
  statusText: document.getElementById('statusText'),
  selectedElement: document.getElementById('selectedElement'),
  permissionModeSelect: document.getElementById('permissionModeSelect') as HTMLSelectElement | null,
  elementTag: document.getElementById('elementTag'),
  messages: document.getElementById('messages'),
  messageInput: document.getElementById('messageInput') as HTMLTextAreaElement | null,
  sendBtn: document.getElementById('sendBtn') as HTMLButtonElement | null,
  selectBtn: document.getElementById('selectBtn') as HTMLButtonElement | null,
  stopBtn: document.getElementById('stopBtn') as HTMLButtonElement | null,
  thinkingIndicator: document.getElementById('thinkingIndicator'),
  sessionSelector: document.getElementById('sessionSelector'),
  sdkSessionSelect: document.getElementById('sdkSessionSelect') as HTMLSelectElement | null,
  sessionBadge: document.getElementById('sessionBadge'),
  tabIndicator: document.getElementById('tabIndicator'),
  tabIndicatorText: document.getElementById('tabIndicatorText')
};

// Initialize Permission Mode Controller
const permissionModeController = new PermissionModeController(
  'permissionModeSelect',
  addMessage,
  sendRuntimeMessage
);

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message: BackgroundToSidepanelMessage) => {
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
function updateConnectionStatus(connected: boolean): void {
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
    // First, try to get SDK session ID from Chrome storage (more reliable)
    let sdkSessionIdForHistory = null;
    if (currentTabId) {
      const storageKey = `sdk_session_${currentTabId}`;
      const result = await chrome.storage.local.get(storageKey);
      sdkSessionIdForHistory = result[storageKey];
      if (sdkSessionIdForHistory) {
        console.log(`[UI CHATTER] Found SDK session in storage: ${sdkSessionIdForHistory}`);
      }
    }

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

      // Clear current messages before loading new session history
      clearMessages();

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

  // Load input history for this tab
  await InputHistoryController.loadHistory(tabId);

  // Close history modal if open
  if (InputHistoryController.modal?.style.display === 'block') {
    InputHistoryController.closeModal();
  }
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
function handleElementCaptured(context: CapturedElement): void {
  currentContext = context;
  const el = context.element;

  console.log('[UI CHATTER] Element captured:', {
    tagName: el.tagName,
    id: el.id,
    classes: el.classList,
    context
  });

  // Show selected element
  elements.selectedElement.classList.add('visible');
  elements.elementTag.textContent = `<${el.tagName}${el.id ? ` id="${el.id}"` : ''}${el.classList.length ? ` class="${el.classList.join(' ')}"` : ''}>`;

  // Focus input (always enabled now)
  elements.messageInput.focus();

  // Add message
  addMessage('status', `Element selected: ${el.tagName}`);
}

// Handle server messages - multi-channel protocol
function handleServerMessage(message: ServerMessage): void {
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
      if (message.type === 'stream_control') {
        handleStreamControl(message);
      }
      break;

    case MessageType.RESPONSE_CHUNK:
      if (message.type === 'response_chunk') {
        handleResponseChunk(message);
      }
      break;

    case MessageType.THINKING:
      if (message.type === 'thinking') {
        handleThinking(message);
      }
      break;

    case MessageType.TOOL_ACTIVITY:
      if (message.type === 'tool_activity') {
        handleToolActivity(message);
      }
      break;

    case MessageType.STATUS:
      // Legacy status messages
      if (message.type === 'status') {
        if (message.status !== 'thinking' && message.status !== 'done') {
          addMessage('status', message.detail || message.status);
        }
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
        fetchSdkSessions();
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
      if (message.type === 'error') {
        addMessage('error', message.message);
        hideStreamingUI();
      }
      break;
  }
}

function handleStreamControl(message: StreamControlMessage): void {
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

      // Save to Chrome local storage for persistence across reconnects
      if (currentTabId) {
        const storageKey = `sdk_session_${currentTabId}`;
        await chrome.storage.local.set({ [storageKey]: currentSdkSessionId });
        console.log(`[UI CHATTER] Saved SDK session to storage: ${storageKey} = ${currentSdkSessionId}`);
      }

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

// Handle thinking messages
let thinkingPanel: HTMLElement | null = null;
function handleThinking(message) {
  const { content, signature, done } = message;

  // Create or update thinking panel
  if (!thinkingPanel) {
    thinkingPanel = document.createElement('div');
    thinkingPanel.className = 'thinking-panel';
    thinkingPanel.innerHTML = `
      <div class="thinking-header">
        <span class="thinking-icon">🧠</span>
        <span class="thinking-label">Claude is thinking...</span>
        ${signature ? `<span class="thinking-signature">✓</span>` : ''}
      </div>
      <details class="thinking-details">
        <summary>View extended thinking</summary>
        <pre class="thinking-content"></pre>
      </details>
    `;
    elements.messages.appendChild(thinkingPanel);
  }

  // Update content
  const contentElement = thinkingPanel.querySelector('.thinking-content');
  if (contentElement) {
    contentElement.textContent = content;
  }

  // Auto-scroll
  elements.messages.scrollTop = elements.messages.scrollHeight;

  // Remove panel when thinking is done
  if (done) {
    setTimeout(() => {
      if (thinkingPanel) {
        thinkingPanel.remove();
        thinkingPanel = null;
      }
    }, 500);
  }
}

// Render markdown content with syntax highlighting
function renderMarkdown(messageElement) {
  const rawContent = messageElement.dataset.rawContent;
  if (!rawContent) return;

  console.log('[MARKDOWN] Starting render, content length:', rawContent.length);

  // Get the content wrapper (first child)
  const contentWrapper = messageElement.querySelector('.message-content');
  if (!contentWrapper) {
    console.warn('No content wrapper found, skipping markdown render');
    return;
  }

  // Check if libraries are loaded
  if (!librariesLoaded || typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
    console.warn('Markdown libraries not loaded, showing plain text');
    contentWrapper.textContent = rawContent;
    return;
  }

  try {
    // Parse markdown
    const parsed = marked.parse(rawContent);

    // Sanitize HTML (DOMPurify hook is configured once in checkLibraries)
    const sanitized = DOMPurify.sanitize(parsed, {
      ALLOWED_TAGS: [
        'p', 'br', 'strong', 'em', 'code', 'pre',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'ul', 'ol', 'li', 'blockquote', 'a'
      ],
      ALLOWED_ATTR: ['href', 'class'],
      ALLOW_DATA_ATTR: false
    });

    // Set HTML in content wrapper only (preserves copy button)
    contentWrapper.innerHTML = sanitized;

    // Apply syntax highlighting if Prism is available
    if (typeof Prism !== 'undefined') {
      contentWrapper.querySelectorAll('pre code').forEach(block => {
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
    contentWrapper.textContent = rawContent;
    // Show user-visible error
    addMessage('error', 'Failed to render markdown. Showing plain text.');
  }
}

function handleToolActivity(message: ToolActivityMessage): void {
  const { tool_id, tool_name, status, input_summary, input, output_summary, output, duration_ms } = message;

  // Get existing tool data or create new
  const existingTool = activeTools.get(tool_id);

  // Update tool map
  activeTools.set(tool_id, {
    name: tool_name,
    status,
    input_summary: input_summary || '',
    input: input || existingTool?.input,  // Preserve input from earlier messages
    output_summary: output_summary || existingTool?.output_summary,
    output: output || existingTool?.output,
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

  // Create content wrapper for proper layout
  const contentWrapper = document.createElement('div');
  contentWrapper.className = 'message-content';
  contentWrapper.textContent = content;
  messageDiv.appendChild(contentWrapper);

  // Add copy button for user and assistant messages
  if (role === 'user' || role === 'assistant') {
    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
    copyBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
      </svg>
    `;
    copyBtn.title = 'Copy to clipboard';

    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();

      // Get the raw content from dataset if available (for markdown), otherwise use textContent
      const textToCopy = messageDiv.dataset.rawContent || contentWrapper.textContent;

      try {
        await navigator.clipboard.writeText(textToCopy);

        // Visual feedback - show checkmark
        copyBtn.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        `;
        copyBtn.classList.add('copied');
        copyBtn.title = 'Copied!';

        setTimeout(() => {
          copyBtn.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
          `;
          copyBtn.classList.remove('copied');
          copyBtn.title = 'Copy to clipboard';
        }, 2000);
      } catch (err) {
        console.error('Failed to copy:', err);
      }
    });

    messageDiv.appendChild(copyBtn);
  }

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
      if (activeToolPanel) {
        activeToolPanel.remove();
        activeToolPanel = null;
        activeTools.clear();
      }
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

  const tools = Array.from(activeTools.entries());
  const completed = tools.filter(([_, t]) => t.status === 'completed').length;
  const executing = tools.filter(([_, t]) => t.status === 'executing').length;
  const pending = tools.filter(([_, t]) => t.status === 'pending').length;
  const failed = tools.filter(([_, t]) => t.status === 'failed').length;

  activeToolPanel.innerHTML = `
    <div class="tool-panel-header">
      <span class="tool-icon">⚙️</span>
      <span>Claude is working...</span>
      <button class="cancel-btn" onclick="cancelStream()">Cancel</button>
    </div>
    <div class="tool-list">
      ${tools.map(([tool_id, t]) => `
        <div class="tool-item tool-${t.status}">
          <span class="tool-status">${getStatusIcon(t.status)}</span>
          <span class="tool-name">${t.name}</span>
          <span class="tool-input-summary">${truncate(t.input_summary || '', 40)}</span>
          <span class="tool-duration">${t.duration ? t.duration + 'ms' : ''}</span>
        </div>
        ${t.input || t.output ? `
          <div class="tool-details-wrapper">
            ${t.input ? `
              <details class="tool-details">
                <summary class="tool-details-summary">Show input</summary>
                <pre class="tool-details-content">${JSON.stringify(t.input, null, 2)}</pre>
              </details>
            ` : ''}
            ${t.output_summary || t.output ? `
              <details class="tool-details">
                <summary class="tool-details-summary">Show output${t.output_summary ? ` (${truncate(t.output_summary, 50)})` : ''}</summary>
                <pre class="tool-details-content">${typeof t.output === 'string' ? t.output : JSON.stringify(t.output, null, 2)}</pre>
              </details>
            ` : ''}
          </div>
        ` : ''}
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

  // Add to input history (if not /clear command)
  if (currentTabId) {
    InputHistoryController.addToHistory(currentTabId, message);
  }

  // Clear input
  elements.messageInput.value = '';

  // Reset last assistant message
  lastAssistantMessage = null;

  console.log('[UI CHATTER] Sending chat message with context:', {
    message,
    elementContext: currentContext
  });

  // Send to background script (context is optional)
  sendRuntimeMessage({
    type: RuntimeMessageType.SEND_CHAT,
    elementContext: currentContext || null,
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

// Arrow key navigation for input history (must check autocomplete first)
elements.messageInput.addEventListener('keydown', (e) => {
  // Don't interfere with autocomplete
  if (AutocompleteController.isVisible) return;

  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    InputHistoryController.handleArrowNavigation(e.key === 'ArrowUp' ? 'up' : 'down');
  }
});

// Exit navigation mode when user types
elements.messageInput.addEventListener('input', (e) => {
  // Don't exit if autocomplete is handling it
  if (AutocompleteController.isVisible) return;

  InputHistoryController.exitNavigationMode();
});

// Ctrl+R to open fuzzy search modal
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'r') {
    e.preventDefault();
    InputHistoryController.openSearchModal();
  }
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
      const input = document.getElementById('messageInput') as HTMLTextAreaElement | null;
      if (input) {
        input.classList.remove('needs-activation');
        if (input.placeholder === 'Click here to start typing...') {
          input.placeholder = 'Type your message...';
        }
      }
      console.log('[FOCUS] Panel activated on first click');
    }
    // Don't steal focus if user clicked a button or input
    if (e.target && e.target instanceof Element && !e.target.matches('button, input, select, textarea, a')) {
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
  // console.log('[AUTOCOMPLETE] Initializing...');
  AutocompleteController.init(elements.messageInput, () => currentSessionId);
})();

// Initialize input history
(function() {
  console.log('[INPUT HISTORY] Initializing...');
  InputHistoryController.init(
    () => currentTabId,
    () => elements.messageInput
  );
})();

// Initialize permission mode controller
(async function initializePermissionMode() {
  await permissionModeController.initialize();
})();

// Shift+Tab to cycle through permission modes
document.addEventListener('keydown', (e) => {
  // Check for Shift+Tab
  if (e.shiftKey && e.key === 'Tab') {
    // Don't interfere with permission modal
    if (currentPermissionRequest || document.getElementById('permissionModal')?.style.display === 'block') {
      return;
    }

    e.preventDefault();
    permissionModeController.cycleMode();
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
    plan,
    questions,
    timeout_seconds
  } = message;

  currentPermissionRequest = {
    request_id,
    request_type,
    tool_name: tool_name || '',
    input_data: input_data || null,
    questions,
    plan: plan || null
  };

  if (request_type === 'ask_user_question') {
    showAskUserQuestion(questions, timeout_seconds || 60);
  } else if (request_type === 'plan_approval') {
    showPlanApproval(plan, timeout_seconds || 300);
  } else {
    showToolPermission(tool_name, input_data, timeout_seconds || 60);
  }
}

function showPlanApproval(planMarkdown, timeoutSeconds) {
  // Show tool approval UI for plan, hide question UI
  document.getElementById('toolApprovalContent').style.display = 'block';
  document.getElementById('questionContainer').style.display = 'none';

  // Populate tool details
  document.getElementById('permissionToolName').textContent = 'ExitPlanMode';

  // Render plan as markdown instead of raw text
  const toolInputEl = document.getElementById('permissionToolInput');
  try {
    // Use marked to render markdown
    if (window.marked) {
      toolInputEl.innerHTML = window.marked.parse(planMarkdown || '');
      toolInputEl.classList.add('rendered-markdown');
    } else {
      toolInputEl.textContent = planMarkdown || '';
    }
  } catch (error) {
    console.error('[PLAN APPROVAL] Markdown rendering failed:', error);
    toolInputEl.textContent = planMarkdown || '';
  }

  // Show modal
  document.getElementById('permissionModal').style.display = 'block';

  // Start countdown timer (298s client-side for 5 minute timeout)
  startPermissionTimer(Math.max(298, timeoutSeconds - 2));

  // Focus allow button for keyboard accessibility
  document.getElementById('allowBtn').focus();
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

async function respondToPermission(approved, modifiedInput = null, answers = null) {
  clearInterval(permissionTimer);

  // Track if this is a plan approval for auto-continue
  const isPlanApproval = currentPermissionRequest?.request_type === 'plan_approval';

  // If approving a plan, automatically switch to acceptEdits mode
  if (approved && isPlanApproval) {
    await permissionModeController.handlePlanApproval();
  }

  // Send response via background script
  sendRuntimeMessage({
    type: RuntimeMessageType.SEND_TO_SERVER,
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

  // Auto-continue after plan approval
  // Wait for permission mode update to complete, then send continuation message
  if (approved && isPlanApproval) {
    console.log('[PLAN APPROVAL] Auto-continuing implementation...');

    // Add visual feedback
    addMessage('user', 'Please proceed with implementing the approved plan.');

    // Wait a bit for mode switch to complete
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Automatically send a message to continue with implementation
    // Use the same format as normal message sending
    sendRuntimeMessage({
      type: RuntimeMessageType.SEND_CHAT,
      elementContext: null,
      message: 'Please proceed with implementing the approved plan.'
    });
  }
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
        .map(i => (i as HTMLInputElement).value)
        .join(', ');
    } else {
      // Single select: just the label
      answers[q.question] = (inputs[0] as HTMLInputElement | undefined)?.value || '';
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
    requestAnimationFrame(focusOnVisible);
  }
});

console.log('Side panel loaded');
export {};
