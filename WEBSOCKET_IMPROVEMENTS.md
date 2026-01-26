# WebSocket Message Logging & Keepalive Implementation

## Overview
Added comprehensive debug logging for all WebSocket messages (incoming/outgoing) and implemented a ping/pong keepalive system to prevent connection timeouts.

## Changes Made

### 1. Server-Side: ConnectionManager (`websocket.py`)

**Added Features:**
- Debug logging for all outgoing messages
- Ping/pong keepalive system
- Configurable ping interval and timeout

**Key Changes:**
```python
# New constructor parameters
def __init__(
    self,
    max_connections: int = 100,
    ping_interval: int = 30,      # Ping every 30 seconds
    ping_timeout: int = 10         # Wait 10s for pong
)

# Debug logging in send_message
logger.debug(f"[WS OUT] {session_id[:8]}... | {msg_type} | {json.dumps(message)[:200]}")

# Background ping task
async def _ping_loop(self, session_id: str)
def start_ping(self, session_id: str)
```

**Files Modified:**
- `service/src/ui_chatter/websocket.py`

### 2. Server-Side: WebSocket Endpoint (`main.py`)

**Added Features:**
- Debug logging for all incoming messages
- Automatic ping task startup after handshake
- Pong message handler

**Key Changes:**
```python
# Log incoming messages
logger.debug(f"[WS IN] {session_id[:8]}... | {msg_type} | {json.dumps(data)[:200]}")

# Start keepalive after session creation
connection_manager.start_ping(session_id)

# Handle pong responses
if data["type"] == "pong":
    logger.debug(f"[WS PONG] {session_id[:8]}... | Received pong response")
```

**Files Modified:**
- `service/src/ui_chatter/main.py`

### 3. Extension: Background Service (`background.js`)

**Added Features:**
- Automatic pong response to ping messages
- Debug logging for all incoming/outgoing messages
- Console logging with [WS IN] and [WS OUT] prefixes

**Key Changes:**
```javascript
// Handle ping and respond with pong
if (message.type === 'ping') {
  console.log('[WS] Received ping, sending pong');
  ws.send(JSON.stringify({ type: 'pong' }));
  return;
}

// Log all messages
console.log('[WS IN]', message.type, message);
console.log('[WS OUT]', msgType, message);
```

**Files Modified:**
- `poc/extension/background.js`

## How to Use

### Enable Debug Logging (Server)
Start the server with the `--debug` flag to see all WebSocket messages:

```bash
ui-chatter serve --debug
```

**Expected Output:**
```
2026-01-26 13:45:00 | DEBUG    | [WS IN] bf832da7... | handshake | {"type":"handshake","permission_mode":"plan"}
2026-01-26 13:45:00 | INFO     | Received handshake with permission mode: plan
2026-01-26 13:45:00 | DEBUG    | Started ping task for session bf832da7-1cfa-494c-8f55-0e7df0ea9697
2026-01-26 13:45:30 | DEBUG    | [WS PING] bf832da7... | Sending keepalive ping
2026-01-26 13:45:30 | DEBUG    | [WS OUT] bf832da7... | ping | {"type":"ping"}
2026-01-26 13:45:30 | DEBUG    | [WS IN] bf832da7... | pong | {"type":"pong"}
2026-01-26 13:45:30 | DEBUG    | [WS PONG] bf832da7... | Received pong response
2026-01-26 13:46:00 | DEBUG    | [WS IN] bf832da7... | chat | {"type":"chat","context":{...},"message":"Hello"}
2026-01-26 13:46:00 | DEBUG    | [WS OUT] bf832da7... | status | {"type":"status","status":"thinking"}
```

### Enable Debug Logging (Extension)
Open Chrome DevTools for the extension background service worker:

1. Go to `chrome://extensions/`
2. Enable "Developer mode"
3. Find "UI Chatter POC"
4. Click "service worker" under "Inspect views"
5. Check the Console tab

**Expected Output:**
```
[WS OUT] handshake {type: 'handshake', permission_mode: 'plan'}
Connected to POC server
[WS IN] ping {type: 'ping'}
[WS] Received ping, sending pong
[WS OUT] chat {type: 'chat', context: {...}, message: 'Hello'}
[WS IN] status {type: 'status', status: 'thinking'}
```

## Keepalive System

### How It Works

1. **Server starts ping task** after successful handshake
2. **Every 30 seconds**, server sends `{"type": "ping"}`
3. **Extension responds immediately** with `{"type": "pong"}`
4. **If ping fails** (connection dead), the send operation will fail and cleanup will occur

### Benefits

- **Prevents idle timeouts**: Keeps connection alive during long thinking periods
- **Early detection**: Detects dead connections within 30 seconds
- **Automatic cleanup**: Failed pings trigger connection cleanup
- **Minimal overhead**: Only 2 small messages per minute

### Configuration

To adjust ping interval, modify `ConnectionManager` initialization in `main.py`:

```python
connection_manager = ConnectionManager(
    max_connections=settings.MAX_CONNECTIONS,
    ping_interval=30,  # seconds between pings
    ping_timeout=10    # seconds to wait for pong (future use)
)
```

## Debugging Tips

### Check WebSocket Connection Health

**Server logs:**
```bash
# Look for ping/pong messages
grep "WS PING\|WS PONG" logs.txt

# Count messages per session
grep "WS IN.*bf832da7" logs.txt | wc -l
grep "WS OUT.*bf832da7" logs.txt | wc -l
```

**Extension console:**
```javascript
// Filter for WebSocket messages
// In DevTools Console, use filter: "WS"
```

### Common Issues

**Connection closes after 30 seconds:**
- Extension not responding to pings
- Check extension console for ping messages
- Verify pong response is sent

**No ping messages:**
- Server not running with `--debug`
- Ping task not started (check session creation logs)
- Connection closed before ping task started

**Ping but no pong:**
- Extension background service worker crashed
- Extension not handling ping message type
- WebSocket connection already dead

## Message Format Reference

### Server → Extension

```javascript
// Ping keepalive
{ type: "ping" }

// Status updates
{ type: "status", status: "thinking"|"done"|"error", detail: "..." }

// Response chunks
{ type: "response_chunk", content: "...", done: false }

// Permission mode acknowledgment
{ type: "permission_mode_updated", mode: "plan"|"bypassPermissions" }

// Error messages
{ type: "error", code: "...", message: "..." }
```

### Extension → Server

```javascript
// Pong keepalive response
{ type: "pong" }

// Initial handshake
{ type: "handshake", permission_mode: "plan"|"bypassPermissions" }

// Chat message
{ type: "chat", context: {...}, message: "..." }

// Permission mode update
{ type: "update_permission_mode", mode: "plan"|"bypassPermissions" }
```

## Performance Impact

- **Bandwidth**: ~20 bytes per ping/pong (60 bytes/min per connection)
- **CPU**: Negligible (async sleep + JSON encode/decode)
- **Memory**: One asyncio task per connection (~1KB)

## Future Enhancements

1. **Adaptive ping interval**: Increase interval for stable connections
2. **Pong timeout enforcement**: Disconnect if no pong within timeout
3. **Connection metrics**: Track ping latency and packet loss
4. **Session resumption**: Allow reconnection to existing session ID
5. **Message queue**: Buffer messages during brief disconnections

## Testing Checklist

- [ ] Start server with `--debug` flag
- [ ] Open extension and verify handshake logged
- [ ] Wait 30 seconds and verify ping sent
- [ ] Check extension console for ping received and pong sent
- [ ] Check server logs for pong received
- [ ] Send chat message and verify all messages logged
- [ ] Toggle permission mode and verify update logged
- [ ] Leave connection idle for 5 minutes, verify pings continue
- [ ] Close extension and verify cleanup logged

## Files Changed

### Server (Python)
- `service/src/ui_chatter/websocket.py` - ConnectionManager with ping/pong
- `service/src/ui_chatter/main.py` - Message logging and ping task startup

### Extension (JavaScript)
- `poc/extension/background.js` - Pong handler and message logging
