# ADR-0001: Use Claude Agent SDK Over ACP for Browser Integration

**Status**: Accepted
**Date**: 2026-01-25
**Deciders**: Technical evaluation via POC
**Technical Story**: [TS-0001 ACP Browser Integration POC](../../tech-specs/draft/TS-0001-acp-browser-integration-poc.md)

---

## Context

UI Chatter requires a backend service that connects a Chrome extension to Claude Code for real-time chat about UI elements. Two architectural approaches were considered:

1. **ACP (Agent Client Protocol)** - Spawn Claude Code as subprocess per request
2. **Claude Agent SDK** - Long-running Python process with in-memory agent

Both approaches were documented in the initial tech brainstorm, but a POC was needed to measure real-world latency and validate the architecture.

---

## Decision

**We will use Claude Agent SDK (Python + FastAPI) instead of ACP (Node.js + subprocess).**

The backend service will be:
- Python 3.10+ with FastAPI
- Claude Agent SDK for in-process agent execution
- WebSocket server for browser communication
- Project-local storage in `.ui-chatter/`

---

## Rationale

### POC Results (2026-01-25)

A complete end-to-end POC was built to test the ACP approach:

| Metric | Target | ACP Actual | Result |
|--------|--------|------------|--------|
| First token latency | < 3s | **~60s** | ❌ FAILED |
| Total response time | < 5s | **~60.5s** | ❌ FAILED |

**Latency breakdown:**
- Subprocess spawn: ~1-2s
- Claude Code initialization: ~58s
- AI processing: <1s

The 60-second latency is **20x higher than the 3-second target** and makes the tool unusable for real-time chat.

### Why Agent SDK Wins

| Factor | ACP | Agent SDK | Winner |
|--------|-----|-----------|--------|
| **Latency** | ~60s per request | ~0.5s (in-process) | Agent SDK |
| **Startup overhead** | Every request | One-time at boot | Agent SDK |
| **Streaming** | Complex (stdio pipes) | Native async | Agent SDK |
| **Memory** | Low (ephemeral) | Higher (persistent) | Neutral |
| **Ecosystem** | Open standard | Vendor-specific | ACP |
| **OAuth support** | ✅ Verified | ✅ Verified | Both |
| **Max subscription** | ✅ Works | ✅ Works | Both |

**Key insight**: Most of the latency is initialization overhead, not AI processing. Agent SDK eliminates this by keeping the agent in memory.

---

## Consequences

### Positive

✅ **100x better latency** - <1s vs 60s enables real-time chat UX
✅ **Native streaming** - Python async/await is cleaner than stdio pipes
✅ **Already verified** - Max subscription OAuth works with Agent SDK
✅ **Better tooling** - FastAPI + WebSockets pairs well with Python
✅ **Reuse POC learnings** - Chrome extension and WebSocket protocol are unchanged

### Negative

❌ **Vendor lock-in** - Tied to Anthropic's SDK instead of open ACP standard
❌ **Language diversity** - Python service + TypeScript extension (vs all TypeScript)
❌ **Memory footprint** - Long-running process uses more RAM than subprocess
❌ **SDK maintenance** - Must track Agent SDK version updates

### Neutral

- Architecture validation from POC still applies
- WebSocket communication pattern is identical
- Chrome extension code can be reused as-is
- Project-local storage design is unchanged

---

## Alternatives Considered

### Option A: Optimize ACP Approach

Could we reduce the 60s latency?

**Rejected**: Subprocess spawn overhead is fundamental. Even if we optimized:
- Best case: 5-10s (still too slow)
- Would require custom Claude Code build
- Not worth the engineering effort

### Option B: Hybrid Approach

Use ACP for non-interactive tasks, Agent SDK for chat?

**Rejected**: Adds complexity without clear benefit. Chat is the primary use case.

### Option C: Different CLI Tool

Use a lighter-weight AI CLI instead of Claude Code?

**Rejected**: We specifically want Claude Code integration for:
- Access to project settings
- Consistent tool permissions
- Max subscription OAuth

---

## Implementation Plan

### Phase 1: Service Scaffolding
- Scaffold Python FastAPI project
- Install Claude Agent SDK
- Implement WebSocket server (reuse POC protocol)
- Test basic agent query

### Phase 2: Integration
- Screenshot storage (`.ui-chatter/screenshots/`)
- Session management (multi-tab support)
- Settings inheritance from `.claude/settings.json`
- Security hooks (project-scope enforcement)

### Phase 3: Polish
- Conversation history (SQLite)
- CLI: `ui-chatter serve`
- Documentation and testing

**Estimated timeline**: 2-3 weeks to MVP

---

## Validation

### Success Metrics

- [ ] First token latency < 1s (vs 60s with ACP)
- [ ] Streaming responses work smoothly
- [ ] Chrome extension connects reliably
- [ ] Works with Max subscription (no API costs)
- [ ] Respects project `.claude/settings.json`

### Test Cases

1. Element selection → chat → response in <2s total
2. Multi-turn conversation (history)
3. Code modification → hot reload
4. Multiple browser tabs (session isolation)

---

## References

- [TS-0001: ACP Browser Integration POC](../../tech-specs/draft/TS-0001-acp-browser-integration-poc.md)
- [POC Results](../../poc/POC-RESULTS.md)
- [Tech Choices Documentation](../tech-brainstorm/2026-01-08-ui-context-bridge/tech-choices.md)
- [Agent SDK Documentation](https://github.com/anthropics/anthropic-sdk-python)

---

## Notes

This decision was **data-driven** via POC. The ACP approach was fully functional (end-to-end working demo), but latency measurements proved it unsuitable for the use case.

The POC code is preserved in `poc/` directory as:
1. Reference implementation of the WebSocket protocol
2. Demonstration of Chrome extension architecture
3. Evidence supporting this decision

Future similar decisions should follow this pattern: **build a throwaway POC to measure, then decide based on data**.
