import { spawn } from 'child_process';
import { buildPrompt } from './prompt-builder.js';
import type { CapturedContext } from './types.js';

export class ACPClient {
  async handleChat(
    context: CapturedContext,
    message: string,
    onChunk: (chunk: string) => void,
    onStatus: (status: string, detail?: string) => void
  ): Promise<void> {
    const prompt = buildPrompt(context, message);

    onStatus('spawning', 'Starting Claude Code...');
    const startTime = Date.now();

    // Spawn Claude Code subprocess
    const claude = spawn('claude', ['--print', '--'], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let firstTokenTime: number | null = null;
    let buffer = '';

    claude.stdout.on('data', (data) => {
      if (!firstTokenTime) {
        firstTokenTime = Date.now();
        const latency = firstTokenTime - startTime;
        console.log(`[METRIC] First token latency: ${latency}ms`);
        onStatus('thinking', `First token received (${latency}ms)`);
      }

      const chunk = data.toString();
      buffer += chunk;
      console.log(`[STDOUT] ${chunk.substring(0, 100)}...`);
      onChunk(chunk);
    });

    claude.stderr.on('data', (data) => {
      const stderr = data.toString();
      console.log(`[STDERR] ${stderr.substring(0, 100)}...`);
      // Claude Code might output to stderr
      if (!firstTokenTime) {
        firstTokenTime = Date.now();
        const latency = firstTokenTime - startTime;
        console.log(`[METRIC] First token latency: ${latency}ms`);
      }
      onChunk(stderr);
    });

    claude.on('close', (code) => {
      const totalTime = Date.now() - startTime;
      console.log(`[METRIC] Total time: ${totalTime}ms`);
      onStatus('done');
    });

    claude.on('error', (err) => {
      console.error('Claude process error:', err);
      onStatus('error', err.message);
    });

    // Send prompt to Claude
    claude.stdin.write(prompt);
    claude.stdin.end();
  }
}
