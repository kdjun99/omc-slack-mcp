# Feasibility Report: Slack MCP Server + Custom Extension

> **Task**: Can the "existing Slack MCP server + custom extension" approach implement bidirectional Slack <-> OMC + Claude Code communication?
> **Verdict**: **YES, fully feasible** with a hybrid architecture

---

## 1. User Requirements

| # | Requirement | Description |
|---|------------|-------------|
| R1 | Outbound notifications | OMC events (session-idle, ask-user-question, session-end, etc.) appear in Slack |
| R2 | Inbound replies | Reply in Slack thread -> text injected into Claude Code tmux session |
| R3 | Standalone | No OMC core code modifications (avoids update conflicts) |
| R4 | Bidirectional | Full two-way communication, not just one-way alerts |

---

## 2. Available Building Blocks

### 2.1 @modelcontextprotocol/server-slack (Existing, 8 tools)

| Tool | Purpose | Useful for Us? |
|------|---------|----------------|
| `slack_list_channels` | List workspace channels | Setup/config |
| `slack_post_message` | Post to channel (returns `ts`) | **R1: Outbound** |
| `slack_reply_to_thread` | Reply in thread (needs `thread_ts`) | Response posting |
| `slack_add_reaction` | Add emoji reaction | Ack confirmation |
| `slack_get_channel_history` | Get recent messages | Polling for replies |
| `slack_get_thread_replies` | Get thread replies | **R2: Inbound (polling)** |
| `slack_get_users` | List workspace users | User resolution |
| `slack_get_user_profile` | Get user profile | User resolution |

**Auth**: Bot token (`xoxb-*`) via `SLACK_BOT_TOKEN` env var.
**Limitation**: No blocking wait, no Socket Mode, no background listener.

### 2.2 trtd56/AskOnSlackMCP (Existing, 1 tool)

| Tool | Purpose | Mechanism |
|------|---------|-----------|
| `ask_on_slack` | Post question, wait for human reply | Socket Mode + 60s blocking wait |

**Auth**: Bot token + App-level token (`xapp-*`).
**Key feature**: Event-driven response detection via Socket Mode WebSocket. Posts message, mentions user, blocks up to 60s waiting for thread reply.

### 2.3 OMC OpenClaw (Existing, hook bridge)

Bridges OMC hook events to external services. Fire-and-forget, non-blocking.

**Available events**: `session-start`, `session-end`, `ask-user-question`, `stop`, `keyword-detector`, `pre-tool-use`, `post-tool-use`

**Available template variables**: `{{event}}`, `{{sessionId}}`, `{{projectName}}`, `{{projectPath}}`, `{{question}}`, `{{tmuxTail}}`, `{{timestamp}}`, `{{contextSummary}}`, `{{reason}}`

**Gateway types**: HTTP (HTTPS required for remote, HTTP OK for localhost) and Command (shell execution with variable interpolation).

### 2.4 MCP SDK (@modelcontextprotocol/sdk)

Allows creating custom MCP servers with custom tools. Supports:
- STDIO transport (standard for Claude Code)
- Background processes (child process + IPC)
- Async tool handlers with configurable timeouts

---

## 3. Architecture Options

### Option A: Two Existing MCP Servers (No Custom Code)

```
Claude Code
  ├── @modelcontextprotocol/server-slack  (outbound: post_message)
  └── trtd56/AskOnSlackMCP               (inbound: ask_on_slack with 60s wait)

OMC OpenClaw (command gateway)
  └── on ask-user-question → calls MCP tool via CLI bridge
```

**Pros**: Zero custom code, immediate setup.
**Cons**:
- OpenClaw cannot directly invoke MCP tools (fire-and-forget, no return channel)
- OMC notifications require Claude to explicitly call `slack_post_message` (not automatic)
- `ask_on_slack` 60s timeout may be too short for complex questions
- Two separate Slack connections (redundant)
- No session registry (can't map Slack threads to tmux panes)

**Verdict**: **Insufficient** for R1 (no automatic outbound) and R2 (no session mapping).

### Option B: Custom MCP Server Wrapping Existing + Extensions

```
Claude Code
  └── omc-slack-mcp (custom MCP server)
        ├── Wraps @slack/web-api (same as server-slack)
        ├── Adds: slack_notify (auto-format OMC events)
        ├── Adds: slack_ask (post + poll for reply)
        ├── Adds: slack_check_reply (poll thread)
        ├── Runs: Socket Mode listener (background)
        └── Manages: session registry (thread_ts -> tmux pane)

OMC OpenClaw (command gateway)
  └── on events → POST http://localhost:{port}/notify
```

**Pros**: Single MCP server, full control, session registry.
**Cons**: Requires building custom MCP server (medium effort).

**Verdict**: **Fully feasible**, recommended approach.

### Option C: Hybrid - Existing MCP + Standalone Daemon

```
Claude Code
  └── @modelcontextprotocol/server-slack  (read/write Slack)

omc-slack-daemon (standalone Node.js process)
  ├── HTTP server on localhost (receives OpenClaw events)
  ├── Socket Mode listener (receives Slack replies)
  ├── Session registry (maps threads to tmux panes)
  └── tmux send-keys (injects replies)

OMC OpenClaw (command gateway)
  └── on events → POST http://localhost:{port}/notify
```

**Pros**: Clean separation, existing MCP server unchanged.
**Cons**: Extra process to manage (start/stop daemon), two Slack connections.

**Verdict**: **Feasible** but more operational overhead than Option B.

---

## 4. Recommended Architecture: Option B (Custom MCP Server)

### 4.1 Why Option B?

1. **Single process**: MCP server handles everything (no daemon to manage)
2. **Session registry**: Maps `{channelId}:{thread_ts}` to tmux pane IDs
3. **Automatic lifecycle**: Claude Code starts/stops the MCP server automatically
4. **Full tool access**: Claude can use Slack tools naturally during conversation
5. **Background listener**: Socket Mode runs as child process inside MCP server
6. **OpenClaw bridge**: Receives OMC events via localhost HTTP endpoint

### 4.2 Tool Design

```
EXISTING TOOLS (from server-slack, reimplemented):
  slack_post_message(channel_id, text) -> {ts, channel}
  slack_reply_to_thread(channel_id, thread_ts, text) -> {ts}
  slack_add_reaction(channel_id, timestamp, reaction) -> ok
  slack_get_channel_history(channel_id, limit?) -> messages[]
  slack_get_thread_replies(channel_id, thread_ts) -> replies[]
  slack_list_channels(limit?, cursor?) -> channels[]

NEW TOOLS (custom extensions):
  slack_ask(channel_id, question, mention?, timeout_s?) -> {reply_text, user_id, ts}
    - Posts question to channel, mentions user
    - Polls for thread reply (every 3s, up to timeout_s, default 120s)
    - Returns first authorized reply or timeout

  slack_check_reply(channel_id, thread_ts) -> {has_reply, reply_text?, user_id?}
    - Non-blocking check for new thread reply
    - Used for manual polling pattern

  slack_register_session(channel_id, thread_ts, tmux_pane_id) -> ok
    - Register mapping: Slack thread -> tmux pane
    - Used by outbound flow after posting notification

  slack_get_session(channel_id, thread_ts) -> {tmux_pane_id, session_id, ...} | null
    - Lookup session by Slack thread
```

### 4.3 Data Flows

#### Outbound (R1): OMC Event -> Slack Notification

```
OMC Hook fires (e.g., session-idle)
  -> OpenClaw command gateway executes:
     curl -s -X POST http://localhost:19280/notify \
       -H 'Content-Type: application/json' \
       -d '{"event":"{{event}}","sessionId":"{{sessionId}}",...}'
  -> MCP server's HTTP endpoint receives event
  -> Formats notification message
  -> Calls Slack chat.postMessage via @slack/web-api
  -> Captures ts, stores in session registry
  -> (Optional) Posts to MCP resource for Claude to see
```

#### Inbound (R2): Slack Reply -> Claude Code

**Path A - Socket Mode (real-time, background)**:
```
User replies in Slack thread
  -> Socket Mode listener (background process) receives event
  -> Looks up session registry: {channelId}:{thread_ts} -> tmux_pane_id
  -> Sanitizes input (strip control chars, escape injection)
  -> tmux send-keys -t {pane_id} "{sanitized_text}" Enter
  -> Adds checkmark reaction to confirm delivery
```

**Path B - Polling (on-demand, via Claude)**:
```
Claude calls slack_check_reply(channel_id, thread_ts)
  -> MCP server calls conversations.replies API
  -> Returns new replies since last check
  -> Claude processes reply in conversation
```

**Path C - Blocking ask (interactive)**:
```
Claude calls slack_ask(channel_id, "What branch should I deploy?", "@user")
  -> Posts message, polls every 3s for reply
  -> Returns reply text when received (or timeout)
  -> Claude continues with the answer
```

### 4.4 Session Registry

JSONL file at `~/.omc/state/slack-session-registry.jsonl`:

```jsonl
{"platform":"slack-bot","messageId":"C07ABC:1709312345.123","sessionId":"abc123","tmuxPaneId":"%5","projectPath":"/Users/.../myproject","event":"session-idle","createdAt":"2026-03-02T14:34:56.000Z"}
```

- **Composite key**: `{channelId}:{thread_ts}` (unique per thread)
- **TTL**: 24h auto-prune on write
- **Lookup**: O(n) scan, sufficient for typical session count (<100)

### 4.5 OpenClaw Configuration

OpenClaw's HTTP gateway natively allows `http://localhost` (validated in `dispatcher.ts:14-28`).
The HTTP gateway is preferred over the command gateway because it sends a rich structured JSON
payload automatically (event, sessionId, projectName, projectPath, tmuxSession, tmuxTail, context).

```json
{
  "enabled": true,
  "gateways": {
    "slack-mcp": {
      "type": "http",
      "url": "http://localhost:19280/notify",
      "method": "POST",
      "timeout": 5000
    }
  },
  "hooks": {
    "session-start": {
      "gateway": "slack-mcp",
      "instruction": "Session started for {{projectName}}",
      "enabled": true
    },
    "session-end": {
      "gateway": "slack-mcp",
      "instruction": "Session ended: {{contextSummary}}",
      "enabled": true
    },
    "ask-user-question": {
      "gateway": "slack-mcp",
      "instruction": "{{question}}",
      "enabled": true
    },
    "stop": {
      "gateway": "slack-mcp",
      "instruction": "Session idle for {{projectName}}",
      "enabled": true
    }
  }
}
```

### 4.6 MCP Server Registration

In `~/.claude/.mcp.json` (or project-level `.mcp.json`):

```json
{
  "mcpServers": {
    "slack": {
      "command": "node",
      "args": ["/path/to/omc-slack-mcp/dist/index.js"],
      "env": {
        "SLACK_BOT_TOKEN": "${OMC_SLACK_BOT_TOKEN}",
        "SLACK_APP_TOKEN": "${OMC_SLACK_APP_TOKEN}",
        "SLACK_CHANNEL_ID": "C07ABC123",
        "SLACK_USER_ID": "U0DEVELOPER",
        "NOTIFY_PORT": "19280"
      }
    }
  }
}
```

---

## 5. Requirement Satisfaction Matrix

| Req | Description | Satisfied? | How |
|-----|------------|------------|-----|
| R1 | Outbound notifications | **YES** | OpenClaw -> localhost HTTP -> MCP server -> Slack API |
| R2 | Inbound replies | **YES** | Socket Mode listener -> session registry -> tmux send-keys |
| R3 | Standalone | **YES** | Custom MCP server package, zero OMC code changes |
| R4 | Bidirectional | **YES** | Outbound via OpenClaw bridge + Inbound via Socket Mode |

---

## 6. Technical Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|-----------|
| MCP server crashes -> no notifications | Medium | OpenClaw command gateway fails silently (fire-and-forget). Restart MCP server via Claude Code restart |
| Socket Mode disconnect | Medium | @slack/bolt auto-reconnects. Lost events acceptable (user can resend) |
| 60s MCP tool timeout for `slack_ask` | Medium | Use polling pattern instead of blocking. `slack_ask` with configurable timeout, fallback to `slack_check_reply` |
| Session registry stale entries | Low | 24h TTL auto-prune. Stale entries cause harmless lookup misses |
| OpenClaw template variable escaping | Low | OpenClaw shell-escapes all variables via single-quote wrapping |
| Concurrent access to JSONL registry | Low | Append-only writes, atomic line-level operations |
| Claude Code restarts -> MCP server restarts -> Socket Mode reconnects | Medium | Bolt reconnects in ~5s. Notification HTTP endpoint briefly unavailable (OpenClaw swallows errors) |

---

## 7. Implementation Effort Estimate

### Package Structure

```
omc-slack-mcp/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # MCP server entry point
│   ├── tools/
│   │   ├── messaging.ts      # post_message, reply_to_thread, add_reaction
│   │   ├── channels.ts       # list_channels, get_history, get_thread_replies
│   │   ├── ask.ts            # slack_ask, slack_check_reply (custom)
│   │   └── session.ts        # register_session, get_session (custom)
│   ├── notify/
│   │   ├── server.ts         # HTTP server for OpenClaw events
│   │   └── formatter.ts      # OMC event -> Slack mrkdwn formatting
│   ├── listener/
│   │   ├── socket-mode.ts    # Slack Socket Mode background listener
│   │   └── injector.ts       # tmux send-keys injection
│   ├── registry/
│   │   └── session.ts        # JSONL session registry
│   └── config.ts             # Configuration from env vars
└── tests/
    ├── messaging.test.ts
    ├── ask.test.ts
    ├── formatter.test.ts
    ├── registry.test.ts
    └── injector.test.ts
```

### Complexity Breakdown

| Component | Complexity | LOC Estimate |
|-----------|-----------|-------------|
| MCP server scaffold | Low | ~80 |
| Messaging tools (6 existing) | Low | ~200 (thin wrappers around @slack/web-api) |
| Custom tools (4 new) | Medium | ~250 |
| HTTP notify endpoint | Low | ~100 |
| OMC event formatter | Medium | ~150 |
| Socket Mode listener | Medium | ~200 |
| tmux injector | Medium | ~100 (port from OMC's injectReply pattern) |
| Session registry | Low | ~120 |
| Config | Low | ~60 |
| Tests | Medium | ~400 |
| **Total** | | **~1,660 LOC** |

### Dependencies

| Package | Purpose | Size |
|---------|---------|------|
| `@modelcontextprotocol/sdk` | MCP server framework | Required |
| `@slack/web-api` | Slack Bot API client | Required |
| `@slack/bolt` | Socket Mode listener | Required (Phase 2) |
| `zod` | Tool parameter validation | Required |
| `vitest` | Testing | Dev only |
| `tsx` | TypeScript execution | Dev only |

---

## 8. Comparison with Previous Approaches

| Aspect | OMC Core Integration (v3, rejected) | Standalone Daemon (v1, rejected) | MCP Server (this proposal) |
|--------|--------------------------------------|----------------------------------|---------------------------|
| OMC code changes | 6 files modified | None (but HTTPS issue) | **None** |
| Update resilience | Breaks on OMC update | Independent | **Independent** |
| Process management | Built into OMC | Separate daemon (start/stop) | **Auto-managed by Claude Code** |
| Outbound mechanism | OMC dispatcher | HTTP webhook | **OpenClaw -> localhost HTTP** |
| Inbound mechanism | OMC reply-listener | Socket Mode daemon | **Socket Mode in MCP server** |
| Session registry | OMC's JSONL | Own JSONL | **Own JSONL** |
| Complexity | High (6 modules) | Medium (daemon + CLI) | **Medium (MCP server)** |
| Claude tool access | N/A | N/A | **Native MCP tools** |

---

## 9. Conclusion

The **Custom MCP Server** approach (Option B) is the optimal path:

1. **Fully standalone** - zero OMC core modifications
2. **Auto-managed** - Claude Code starts/stops the MCP server automatically
3. **Native tool access** - Claude can directly `slack_post_message`, `slack_ask`, etc.
4. **Bidirectional** - outbound via OpenClaw bridge, inbound via Socket Mode
5. **Proven patterns** - @slack/web-api for outbound, @slack/bolt for inbound, MCP SDK for tools
6. **Reference implementations** - trtd56/AskOnSlackMCP proves the ask-and-wait pattern works
7. **Moderate effort** - ~1,660 LOC estimated, standard TypeScript/Node.js stack

**Recommended next step**: Create new ARCHITECTURE.md (v4) based on this feasibility analysis, then implement Phase 1 (outbound via MCP tools + OpenClaw bridge).
