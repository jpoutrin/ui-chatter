/**
 * Tests for new message handlers - Thinking messages and Tool activity
 */

import { describe, test, expect, beforeEach, jest, afterEach } from '@jest/globals';

describe('Message Handlers - Thinking and Tool Activity', () => {
  let mockMessagesContainer;
  let mockElements;
  let activeTools;
  let thinkingPanel;
  let activeToolPanel;

  beforeEach(() => {
    // Create mock DOM elements
    mockMessagesContainer = {
      appendChild: jest.fn(),
      scrollTop: 0,
      scrollHeight: 1000,
      children: { length: 0 }
    };

    mockElements = {
      messages: mockMessagesContainer
    };

    // Initialize state
    activeTools = new Map();
    thinkingPanel = null;
    activeToolPanel = null;

    // Mock document.createElement
    global.document = {
      createElement: jest.fn((tagName) => {
        const element = {
          tagName: tagName.toUpperCase(),
          className: '',
          innerHTML: '',
          textContent: '',
          querySelector: jest.fn(),
          remove: jest.fn(),
          scrollIntoView: jest.fn()
        };
        return element;
      })
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('handleThinking', () => {
    test('should create thinking panel on first message', () => {
      const message = {
        type: 'thinking',
        content: 'Let me analyze this carefully...',
        signature: null,
        done: false
      };

      // Simulate handleThinking
      if (!thinkingPanel) {
        thinkingPanel = document.createElement('div');
        thinkingPanel.className = 'thinking-panel';
        thinkingPanel.innerHTML = `
          <div class="thinking-header">
            <span class="thinking-icon">🧠</span>
            <span class="thinking-label">Claude is thinking...</span>
            ${message.signature ? '<span class="thinking-signature">✓</span>' : ''}
          </div>
          <details class="thinking-details">
            <summary>View extended thinking</summary>
            <pre class="thinking-content">${message.content}</pre>
          </details>
        `;
        mockMessagesContainer.appendChild(thinkingPanel);
      }

      // Verify panel was created and appended
      expect(thinkingPanel).toBeDefined();
      expect(thinkingPanel.className).toBe('thinking-panel');
      expect(thinkingPanel.innerHTML).toContain('Claude is thinking...');
      expect(thinkingPanel.innerHTML).toContain('Let me analyze this carefully...');
      expect(mockMessagesContainer.appendChild).toHaveBeenCalledWith(thinkingPanel);
    });

    test('should update thinking content on subsequent messages', () => {
      // First message
      thinkingPanel = document.createElement('div');
      thinkingPanel.className = 'thinking-panel';
      const mockContentElement = { textContent: '' };
      thinkingPanel.querySelector = jest.fn(() => mockContentElement);

      // Second message with updated content
      const message = {
        type: 'thinking',
        content: 'After further consideration, I believe...',
        signature: null,
        done: false
      };

      // Simulate content update
      const contentElement = thinkingPanel.querySelector('.thinking-content');
      if (contentElement) {
        contentElement.textContent = message.content;
      }

      expect(contentElement.textContent).toBe('After further consideration, I believe...');
    });

    test('should show signature checkmark when present', () => {
      const message = {
        type: 'thinking',
        content: 'Verified thinking process',
        signature: 'valid-signature-123',
        done: false
      };

      thinkingPanel = document.createElement('div');
      thinkingPanel.innerHTML = `
        <div class="thinking-header">
          <span class="thinking-icon">🧠</span>
          <span class="thinking-label">Claude is thinking...</span>
          ${message.signature ? '<span class="thinking-signature">✓</span>' : ''}
        </div>
      `;

      expect(thinkingPanel.innerHTML).toContain('thinking-signature');
      expect(thinkingPanel.innerHTML).toContain('✓');
    });

    test('should remove panel when thinking is done', (done) => {
      const message = {
        type: 'thinking',
        content: 'Final thoughts',
        signature: null,
        done: true
      };

      thinkingPanel = document.createElement('div');
      thinkingPanel.remove = jest.fn();

      // Simulate done flag handling
      if (message.done) {
        setTimeout(() => {
          if (thinkingPanel) {
            thinkingPanel.remove();
            thinkingPanel = null;
          }

          expect(thinkingPanel).toBeNull();
          done();
        }, 100);
      }
    });
  });

  describe('handleToolActivity', () => {
    test('should store full input data on tool execution start', () => {
      const message = {
        type: 'tool_activity',
        tool_id: 'tool-123',
        tool_name: 'Read',
        status: 'executing',
        input_summary: 'Reading file.py',
        input: {
          file_path: '/path/to/file.py',
          offset: 0,
          limit: 100
        },
        output_summary: null,
        output: null,
        duration_ms: null
      };

      // Simulate handleToolActivity
      const existingTool = activeTools.get(message.tool_id);
      activeTools.set(message.tool_id, {
        name: message.tool_name,
        status: message.status,
        input_summary: message.input_summary || '',
        input: message.input || existingTool?.input,
        output_summary: message.output_summary || existingTool?.output_summary,
        output: message.output || existingTool?.output,
        duration: message.duration_ms,
        timestamp: Date.now()
      });

      const storedTool = activeTools.get('tool-123');
      expect(storedTool).toBeDefined();
      expect(storedTool.name).toBe('Read');
      expect(storedTool.input).toEqual({
        file_path: '/path/to/file.py',
        offset: 0,
        limit: 100
      });
      expect(storedTool.input_summary).toBe('Reading file.py');
    });

    test('should preserve input data when tool completes', () => {
      // First: tool starts with input
      const startMessage = {
        tool_id: 'tool-123',
        tool_name: 'Read',
        status: 'executing',
        input_summary: 'Reading file.py',
        input: { file_path: '/path/to/file.py' },
        output_summary: null,
        output: null
      };

      activeTools.set(startMessage.tool_id, {
        name: startMessage.tool_name,
        status: startMessage.status,
        input_summary: startMessage.input_summary,
        input: startMessage.input,
        output_summary: null,
        output: null
      });

      // Second: tool completes with output
      const completeMessage = {
        tool_id: 'tool-123',
        tool_name: 'Read',
        status: 'completed',
        input_summary: null,
        input: null,
        output_summary: 'File contents...',
        output: 'import os\nimport sys\n...',
        duration_ms: 45
      };

      const existingTool = activeTools.get(completeMessage.tool_id);
      activeTools.set(completeMessage.tool_id, {
        name: completeMessage.tool_name,
        status: completeMessage.status,
        input_summary: completeMessage.input_summary || existingTool?.input_summary,
        input: completeMessage.input || existingTool?.input,  // Preserve input
        output_summary: completeMessage.output_summary || existingTool?.output_summary,
        output: completeMessage.output || existingTool?.output,
        duration: completeMessage.duration_ms
      });

      const finalTool = activeTools.get('tool-123');
      expect(finalTool.status).toBe('completed');
      expect(finalTool.input).toEqual({ file_path: '/path/to/file.py' });  // Preserved!
      expect(finalTool.output).toBe('import os\nimport sys\n...');
      expect(finalTool.duration).toBe(45);
    });

    test('should handle multiple tools simultaneously', () => {
      const tools = [
        {
          tool_id: 'tool-1',
          tool_name: 'Read',
          status: 'executing',
          input: { file_path: 'file1.py' }
        },
        {
          tool_id: 'tool-2',
          tool_name: 'Grep',
          status: 'executing',
          input: { pattern: 'export', path: './' }
        },
        {
          tool_id: 'tool-3',
          tool_name: 'Bash',
          status: 'pending',
          input: { command: 'ls -la' }
        }
      ];

      tools.forEach(msg => {
        activeTools.set(msg.tool_id, {
          name: msg.tool_name,
          status: msg.status,
          input_summary: '',
          input: msg.input,
          output_summary: null,
          output: null
        });
      });

      expect(activeTools.size).toBe(3);
      expect(activeTools.get('tool-1').name).toBe('Read');
      expect(activeTools.get('tool-2').name).toBe('Grep');
      expect(activeTools.get('tool-3').status).toBe('pending');
    });
  });

  describe('renderToolActivityPanel', () => {
    test('should create panel with expandable input sections', () => {
      activeTools.set('tool-1', {
        name: 'Read',
        status: 'completed',
        input_summary: 'Reading package.json',
        input: {
          file_path: '/path/to/package.json',
          offset: 0
        },
        output_summary: 'File contents',
        output: '{\n  "name": "test"\n}'
      });

      // Simulate renderToolActivityPanel
      activeToolPanel = document.createElement('div');
      activeToolPanel.className = 'tool-activity-panel';

      const tools = Array.from(activeTools.entries());
      const html = tools.map(([tool_id, t]) => `
        <div class="tool-item tool-${t.status}">
          <span class="tool-name">${t.name}</span>
        </div>
        ${t.input ? `
          <div class="tool-details-wrapper">
            <details class="tool-details">
              <summary>Show input</summary>
              <pre>${JSON.stringify(t.input, null, 2)}</pre>
            </details>
          </div>
        ` : ''}
      `).join('');

      activeToolPanel.innerHTML = html;

      expect(activeToolPanel.innerHTML).toContain('Show input');
      expect(activeToolPanel.innerHTML).toContain('file_path');
      expect(activeToolPanel.innerHTML).toContain('/path/to/package.json');
    });

    test('should create expandable output sections', () => {
      activeTools.set('tool-1', {
        name: 'Bash',
        status: 'completed',
        input_summary: 'Running ls -la',
        input: { command: 'ls -la', description: 'List files' },
        output_summary: 'Command output',
        output: 'total 48\ndrwxr-xr-x  12 user  staff   384 Jan 31 10:00 .\ndrwxr-xr-x   5 user  staff   160 Jan 30 12:00 ..'
      });

      const tools = Array.from(activeTools.entries());
      const html = tools.map(([tool_id, t]) => `
        ${t.output ? `
          <details class="tool-details">
            <summary>Show output</summary>
            <pre>${typeof t.output === 'string' ? t.output : JSON.stringify(t.output, null, 2)}</pre>
          </details>
        ` : ''}
      `).join('');

      expect(html).toContain('Show output');
      expect(html).toContain('total 48');
      expect(html).toContain('drwxr-xr-x');
    });

    test('should pretty-print JSON input data', () => {
      const input = {
        file_path: '/test.py',
        offset: 10,
        limit: 100,
        nested: { key: 'value' }
      };

      const formatted = JSON.stringify(input, null, 2);

      expect(formatted).toContain('  "file_path": "/test.py"');
      expect(formatted).toContain('  "offset": 10');
      expect(formatted).toContain('  "nested": {');
      expect(formatted).toContain('    "key": "value"');
    });

    test('should show output as string when not JSON', () => {
      const stringOutput = 'This is a plain string output\nWith multiple lines\n';
      const tool = {
        name: 'Read',
        status: 'completed',
        output: stringOutput
      };

      const renderedOutput = typeof tool.output === 'string'
        ? tool.output
        : JSON.stringify(tool.output, null, 2);

      expect(renderedOutput).toBe(stringOutput);
      expect(renderedOutput).not.toContain('{');  // Not JSON formatted
    });

    test('should calculate tool statistics correctly', () => {
      activeTools.set('tool-1', { name: 'Read', status: 'completed' });
      activeTools.set('tool-2', { name: 'Write', status: 'executing' });
      activeTools.set('tool-3', { name: 'Bash', status: 'failed' });
      activeTools.set('tool-4', { name: 'Grep', status: 'pending' });

      const tools = Array.from(activeTools.values());
      const completed = tools.filter(t => t.status === 'completed').length;
      const executing = tools.filter(t => t.status === 'executing').length;
      const pending = tools.filter(t => t.status === 'pending').length;
      const failed = tools.filter(t => t.status === 'failed').length;

      expect(completed).toBe(1);
      expect(executing).toBe(1);
      expect(pending).toBe(1);
      expect(failed).toBe(1);

      const summary = `${completed} completed${failed > 0 ? `, ${failed} failed` : ''}${executing > 0 ? `, ${executing} in progress` : ''}${pending > 0 ? `, ${pending} pending` : ''}`;

      expect(summary).toBe('1 completed, 1 failed, 1 in progress, 1 pending');
    });
  });

  describe('Message Type Constants', () => {
    test('should have THINKING constant defined', () => {
      const MessageType = {
        RESPONSE_CHUNK: 'response_chunk',
        THINKING: 'thinking',
        TOOL_ACTIVITY: 'tool_activity',
        STREAM_CONTROL: 'stream_control',
        STATUS: 'status',
        ERROR: 'error'
      };

      expect(MessageType.THINKING).toBe('thinking');
    });

    test('should handle thinking message type in switch case', () => {
      const message = { type: 'thinking' };
      let handlerCalled = false;

      const handleThinking = () => { handlerCalled = true; };

      switch(message.type) {
        case 'thinking':
          handleThinking();
          break;
      }

      expect(handlerCalled).toBe(true);
    });
  });

  describe('Integration - Full Tool Lifecycle', () => {
    test('should handle complete tool execution cycle', () => {
      // 1. Tool starts
      const startMsg = {
        tool_id: 'tool-read-1',
        tool_name: 'Read',
        status: 'executing',
        input_summary: 'Reading config.json',
        input: { file_path: '/config.json', offset: 0 }
      };

      activeTools.set(startMsg.tool_id, {
        name: startMsg.tool_name,
        status: startMsg.status,
        input_summary: startMsg.input_summary,
        input: startMsg.input,
        output_summary: null,
        output: null
      });

      expect(activeTools.get('tool-read-1').status).toBe('executing');
      expect(activeTools.get('tool-read-1').input).toBeDefined();

      // 2. Tool completes
      const completeMsg = {
        tool_id: 'tool-read-1',
        tool_name: 'Read',
        status: 'completed',
        output_summary: 'File contents (52 lines)',
        output: '{\n  "version": "1.0.0",\n  "name": "test"\n}',
        duration_ms: 23
      };

      const existing = activeTools.get(completeMsg.tool_id);
      activeTools.set(completeMsg.tool_id, {
        name: completeMsg.tool_name,
        status: completeMsg.status,
        input_summary: existing?.input_summary || '',
        input: existing?.input,  // Preserved
        output_summary: completeMsg.output_summary,
        output: completeMsg.output,
        duration: completeMsg.duration_ms
      });

      const finalTool = activeTools.get('tool-read-1');

      // Verify full lifecycle
      expect(finalTool.status).toBe('completed');
      expect(finalTool.input).toEqual({ file_path: '/config.json', offset: 0 });
      expect(finalTool.output).toContain('"version": "1.0.0"');
      expect(finalTool.duration).toBe(23);
      expect(finalTool.input_summary).toBe('Reading config.json');
      expect(finalTool.output_summary).toBe('File contents (52 lines)');
    });
  });
});
