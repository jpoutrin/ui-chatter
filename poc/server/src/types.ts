// Shared types for POC

export interface CapturedElement {
  tagName: string;
  id?: string;
  classList: string[];
  textContent: string;
  attributes: Record<string, string>;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface CapturedContext {
  element: CapturedElement;
  ancestors: Array<{
    tagName: string;
    id?: string;
    classList: string[];
  }>;
  page: {
    url: string;
    title: string;
  };
}

// WebSocket message types
export interface ChatRequest {
  type: "chat";
  context: CapturedContext;
  screenshot?: string; // base64 PNG (optional for POC)
  message: string;
}

export interface ChatResponseChunk {
  type: "response_chunk";
  content: string;
  done: boolean;
}

export interface StatusUpdate {
  type: "status";
  status: "idle" | "spawning" | "thinking" | "done" | "error";
  detail?: string;
}

export type ClientMessage = ChatRequest | { type: "ping" };
export type ServerMessage = ChatResponseChunk | StatusUpdate | { type: "pong" };
