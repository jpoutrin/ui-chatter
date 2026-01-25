import express from 'express';
import { WebSocketServer } from 'ws';
import { ACPClient } from './acp-client.js';
import type { ClientMessage, ServerMessage, ChatRequest } from './types.js';

const app = express();
const PORT = 3456;

// Middleware
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'ui-chatter-poc-server' });
});

// Start HTTP server
const server = app.listen(PORT, () => {
  console.log(`🚀 POC Server running on http://localhost:${PORT}`);
  console.log(`📡 WebSocket available at ws://localhost:${PORT}`);
});

// WebSocket server
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('📱 Extension connected');

  const acpClient = new ACPClient();

  ws.on('message', async (data) => {
    try {
      const message: ClientMessage = JSON.parse(data.toString());

      if (message.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      if (message.type === 'chat') {
        const chatMsg = message as ChatRequest;
        console.log('💬 Chat request:', chatMsg.message);

        // Handle chat with ACP client
        await acpClient.handleChat(
          chatMsg.context,
          chatMsg.message,
          // onChunk callback
          (chunk: string) => {
            const response: ServerMessage = {
              type: 'response_chunk',
              content: chunk,
              done: false
            };
            ws.send(JSON.stringify(response));
          },
          // onStatus callback
          (status: any, detail?: string) => {
            const statusMsg: ServerMessage = {
              type: 'status',
              status,
              detail
            };
            ws.send(JSON.stringify(statusMsg));
          }
        );

        // Send final done message
        const doneMsg: ServerMessage = {
          type: 'response_chunk',
          content: '',
          done: true
        };
        ws.send(JSON.stringify(doneMsg));
      }
    } catch (err) {
      console.error('Error handling message:', err);
      const errorMsg: ServerMessage = {
        type: 'status',
        status: 'error',
        detail: err instanceof Error ? err.message : 'Unknown error'
      };
      ws.send(JSON.stringify(errorMsg));
    }
  });

  ws.on('close', () => {
    console.log('📱 Extension disconnected');
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Shutting down...');
  wss.close();
  server.close();
  process.exit(0);
});
