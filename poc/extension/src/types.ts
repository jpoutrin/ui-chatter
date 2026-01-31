// Shared type definitions for UI Chatter Extension

// Connection state types
export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';
export type PermissionMode = 'plan' | 'bypassPermissions' | 'acceptEdits';
export type EditorType = 'vscode' | 'cursor' | 'webstorm' | 'sublime' | 'vim';

// Tab connection state
export interface TabConnection {
  ws: WebSocket;
  sessionId: string | null;
  sdkSessionId: string | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  pageUrl: string;
  status: ConnectionStatus;
}

// WebSocket message types (from server)
export interface HandshakeMessage {
  type: 'handshake';
  permission_mode: PermissionMode;
  page_url: string;
  tab_id: string;
}

export interface HandshakeAckMessage {
  type: 'handshake_ack';
  session_id: string | null;
  sdk_session_id?: string | null;
  resumed?: boolean;
}

export interface PingMessage {
  type: 'ping';
}

export interface PongMessage {
  type: 'pong';
}

export interface ResponseChunkMessage {
  type: 'response_chunk';
  content: string;
  done?: boolean;
  [key: string]: unknown;
}

export interface StreamControlMessage {
  type: 'stream_control';
  action: 'started' | 'completed';
}

export interface PermissionRequestMessage {
  type: 'permission_request';
  tool_name: string;
  input_data: unknown;
  timeout_seconds?: number;
}

export interface AskUserQuestionMessage {
  type: 'ask_user_question';
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect: boolean;
  }>;
  timeout_seconds?: number;
}

export type ServerMessage =
  | HandshakeAckMessage
  | PingMessage
  | ResponseChunkMessage
  | StreamControlMessage
  | PermissionRequestMessage
  | AskUserQuestionMessage
  | { type: string; [key: string]: unknown };

export type ClientMessage =
  | HandshakeMessage
  | PongMessage
  | ChatMessage
  | CancelRequestMessage
  | PermissionResponseMessage
  | UserAnswersMessage;

// Client message types (to server)
export interface ChatMessage {
  type: 'chat';
  message: string;
  selected_text?: string | null;
  element_context?: unknown;
}

export interface CancelRequestMessage {
  type: 'cancel_request';
}

export interface PermissionResponseMessage {
  type: 'permission_response';
  approved: boolean;
}

export interface UserAnswersMessage {
  type: 'user_answers';
  answers: Record<string, string>;
}

// Chrome runtime message types
export interface SendChatRuntimeMessage {
  type: 'send_chat';
  message: string;
  selectedText?: string | null;
  elementContext?: unknown;
}

export interface CancelRequestRuntimeMessage {
  type: 'cancel_request';
}

export interface PermissionResponseRuntimeMessage {
  type: 'permission_response';
  approved: boolean;
}

export interface UserAnswersRuntimeMessage {
  type: 'user_answers';
  answers: Record<string, string>;
}

export interface OpenFileRuntimeMessage {
  type: 'open_file';
  filePath: string;
  lineStart?: number;
}

export interface ToggleClickModeRuntimeMessage {
  type: 'toggle_click_mode';
}

export interface RegisterTabSessionRuntimeMessage {
  type: 'register_tab_session';
  tabId: number;
  sessionId: string;
  sdkSessionId: string | null;
  pageUrl: string;
}

export interface UpdateSdkSessionIdRuntimeMessage {
  type: 'update_sdk_session_id';
  tabId: number;
  sdkSessionId: string;
}

export interface ConnectionStatusRuntimeMessage {
  type: 'connection_status';
  status: ConnectionStatus;
  tabId: number;
}

export interface ServerMessageRuntimeMessage {
  type: 'server_message';
  message: ServerMessage;
  tabId: number;
}

export interface TabSwitchedRuntimeMessage {
  type: 'tab_switched';
  tabId: number;
  pageUrl?: string;
  connection: TabConnection | null;
}

export interface ConnectTabRuntimeMessage {
  type: 'connect_tab';
  tabId: number;
  pageUrl: string;
}

export interface DisconnectTabRuntimeMessage {
  type: 'disconnect_tab';
  tabId: number;
}

export interface ElementSelectedRuntimeMessage {
  type: 'element_selected';
  context: unknown;
}

export interface ClearSessionRuntimeMessage {
  type: 'clear_session';
}

export interface PermissionModeChangedRuntimeMessage {
  type: 'permission_mode_changed';
  mode: PermissionMode;
}

export interface RetryWithPermissionRuntimeMessage {
  type: 'retry_with_permission';
}

export interface CancelPermissionRequestRuntimeMessage {
  type: 'cancel_permission_request';
}

export interface GetConnectionStatusRuntimeMessage {
  type: 'get_connection_status';
}

export interface GetTabConnectionRuntimeMessage {
  type: 'get_tab_connection';
  tabId?: number;
}

export interface OpenFileActionMessage {
  action: 'openFile';
  filePath: string;
  lineStart?: number;
}

export type RuntimeMessage =
  | SendChatRuntimeMessage
  | CancelRequestRuntimeMessage
  | PermissionResponseRuntimeMessage
  | UserAnswersRuntimeMessage
  | OpenFileRuntimeMessage
  | ToggleClickModeRuntimeMessage
  | RegisterTabSessionRuntimeMessage
  | UpdateSdkSessionIdRuntimeMessage
  | ConnectionStatusRuntimeMessage
  | ServerMessageRuntimeMessage
  | TabSwitchedRuntimeMessage
  | ConnectTabRuntimeMessage
  | DisconnectTabRuntimeMessage
  | ElementSelectedRuntimeMessage
  | ClearSessionRuntimeMessage
  | PermissionModeChangedRuntimeMessage
  | RetryWithPermissionRuntimeMessage
  | CancelPermissionRequestRuntimeMessage
  | GetConnectionStatusRuntimeMessage
  | GetTabConnectionRuntimeMessage
  | OpenFileActionMessage;

// Editor protocol builder function type
export type EditorProtocolBuilder = (filePath: string, lineStart?: number) => string;

// Settings
export interface Settings {
  preferredEditor?: EditorType;
  maxFilesDisplayed?: number;
  projectPath?: string;
  permissionMode?: PermissionMode;
}
