# UI Chatter ACP POC

Proof of concept to test ACP (subprocess) latency vs Agent SDK approach.

## Goal

Measure if spawning Claude Code as a subprocess has acceptable latency (<3s first token) for chat UX.

## Setup

### 1. Install Server Dependencies

```bash
cd poc/server
npm install
```

### 2. Load Chrome Extension

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select the `poc/extension` directory

### 3. Start the Server

```bash
cd poc/server
npm run dev
```

You should see:
```
🚀 POC Server running on http://localhost:3456
📡 WebSocket available at ws://localhost:3456
```

## Testing

### Basic Flow Test

1. Open any webpage (e.g., `http://localhost:5173` if you have a local dev server)
2. Click the UI Chatter extension icon to open the side panel
3. Click "Select Element" button
4. Click any element on the page
5. Type a message like "describe this element"
6. Click "Send"

### Metrics to Observe

Watch the server console for:
```
[METRIC] First token latency: XXXms
[METRIC] Total time: XXXms
```

**Success criteria**: First token < 3000ms

### Expected Behavior

✅ Side panel shows "Connected" status (green)
✅ Click mode highlights elements on hover (blue outline)
✅ Selected element shows in side panel
✅ Status updates appear ("Starting Claude Code...", "First token received...")
✅ Response streams incrementally in chat

## Known Limitations (POC)

- No screenshot capture (not needed for latency test)
- Spawns fresh Claude Code process per request (intentional for testing)
- No error recovery
- No conversation history
- Single session only

## Next Steps After POC

Based on latency results:
- **If < 2s**: ACP is viable, comparable to Agent SDK
- **If 2-3s**: Borderline, consider UX trade-offs
- **If > 3s**: Recommend Agent SDK approach instead

## Troubleshooting

**"Not connected" status**
- Ensure server is running (`npm run dev`)
- Check server console for errors
- Verify port 3456 is available

**No response when clicking Send**
- Check server console for Claude Code errors
- Ensure `claude` CLI is in PATH
- Try running `claude --version` manually

**Extension not loading**
- Check for errors in `chrome://extensions/`
- Ensure all files are present in `poc/extension/`
- Try reloading the extension
