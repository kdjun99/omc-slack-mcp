# omc-slack-mcp — Architecture (v4)

> Custom MCP Server for bidirectional Slack <-> Claude Code communication
> No OMC core modifications. No OpenClaw dependency. Pure standalone MCP server.

---

## A. Overview

### Problem

Claude Code users interact through the CLI terminal. During long-running tasks (autopilot, ralph, team), there is no way to monitor progress or respond to questions from a phone or another device. Slack would be an ideal interface for this.

### Solution

A standalone MCP server (`omc-slack-mcp`) that Claude Code loads as a plugin. It provides Slack tools that Claude can call directly, plus a background Socket Mode listener for real-time inbound replies.

### Key Constraints

| Constraint | Decision |
|-----------|----------|
| No OMC core modifications | Standalone MCP server package |
| No OpenClaw dependency | Claude calls MCP tools directly (Pull model) |
| No separate daemon to manage | MCP server lifecycle managed by Claude Code |
| Slack Bot API only | No user tokens, no classic apps |

### High-Level Architecture

```
┌──────────────────────────────────────────────────┐
│  Claude Code                                      │
│                                                    │
│  ┌──────────────────────────────────────────────┐ │
│  │  omc-slack-mcp (MCP Server, STDIO transport) │ │
│  │                                               │ │
│  │  MCP Tools (Claude calls directly):           │ │
│  │    slack_post_message     → Slack Web API      │ │
│  │    slack_reply_to_thread  → Slack Web API      │ │
│  │    slack_ask              → Post + Poll reply  │ │
│  │    slack_check_reply      → Poll thread        │ │
│  │    slack_add_reaction     → Slack Web API      │ │
│  │    slack_list_channels    → Slack Web API      │ │
│  │    slack_get_channel_history                   │ │
│  │    slack_get_thread_replies                    │ │
│  │                                               │ │
│  │  Background (started on server init):         │ │
│  │    Socket Mode Listener (@slack/bolt)          │ │
│  │      → receives thread replies                │ │
│  │      → session registry lookup                │ │
│  │      → tmux send-keys injection               │ │
│  │      → reaction confirmation                  │ │
│  │                                               │ │
│  │  State:                                       │ │
│  │    Session Registry (in-memory + JSONL)        │ │
│  │      maps {channelId}:{thread_ts} → tmuxPaneId│ │
│  └──────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────┘
         │                           ▲
         │ Slack Web API             │ Socket Mode (WebSocket)
         ▼                           │
┌──────────────────────────────────────────────────┐
│  Slack Workspace                                  │
│    #omc-notifications channel                     │
│    Thread replies from user                       │
└──────────────────────────────────────────────────┘
```

---

## B. Data Flows

### B.1 Outbound: Claude → Slack (Pull Model)

Claude calls MCP tools directly when it needs to notify the user.

```
Claude Code session event (idle, question, completion, etc.)
  → Claude decides to notify user
  → Calls slack_post_message(channel_id, text)
  → MCP server calls Slack chat.postMessage API
  → Returns { ok, ts, channel }
  → Claude calls slack_register_session(channel_id, ts, tmux_pane_id)
  → Session registry stores mapping for inbound replies
```

No external bridge needed. Claude has native access to MCP tools.

**When does Claude call these tools?**
- OMC skills (ralph, autopilot, ultrawork) can be configured to call `slack_post_message` at key points
- Claude can be instructed via CLAUDE.md or skill prompts to post to Slack
- `slack_ask` can replace or supplement `AskUserQuestion` for remote interaction

### B.2 Inbound: Slack → Claude Code (Socket Mode)

Real-time reply injection via background Socket Mode listener.

```
User replies in Slack thread
  → @slack/bolt receives message event (WebSocket)
  → Filter: thread reply (thread_ts exists, thread_ts !== ts)
  → Filter: not bot's own message (user !== bot_user_id)
  → Filter: no subtype (plain text messages only)
  → Filter: authorized user (user in AUTHORIZED_USER_IDS)
  → Lookup: session registry → {channelId}:{thread_ts} → tmuxPaneId
  → Sanitize: strip control chars, escape shell metacharacters
  → Inject: tmux send-keys -t {paneId} "{sanitized_text}" Enter
  → Confirm: reactions.add("white_check_mark")
```

### B.3 Interactive: Claude asks, User answers (slack_ask)

Blocking tool for Claude to ask a question and wait for the answer.

```
Claude calls slack_ask(channel_id, "Which branch?", mention="<@U123>")
  → MCP server posts message to Slack (with @mention)
  → Polls conversations.replies every 3 seconds
  → Filters for new reply from authorized user
  → Returns { reply_text, user_id, ts } or { timeout: true }
  → Claude continues conversation with the answer
```

Default timeout: 120 seconds (configurable).

---

## C. MCP Tool Specifications

### C.1 Messaging Tools

#### `slack_post_message`

Post a new message to a Slack channel.

```typescript
Input: {
  channel_id: string;   // Required. Slack channel ID (C-prefixed)
  text: string;          // Required. Message text (mrkdwn supported)
}
Output: {
  ok: boolean;
  ts: string;            // Message timestamp (for threading)
  channel: string;       // Channel ID
}
```

#### `slack_reply_to_thread`

Reply to an existing message thread.

```typescript
Input: {
  channel_id: string;    // Required. Channel containing the thread
  thread_ts: string;     // Required. Parent message timestamp
  text: string;          // Required. Reply text
}
Output: {
  ok: boolean;
  ts: string;
}
```

#### `slack_add_reaction`

Add an emoji reaction to a message.

```typescript
Input: {
  channel_id: string;    // Required. Channel containing the message
  timestamp: string;     // Required. Message timestamp
  reaction: string;      // Required. Emoji name without colons (e.g. "eyes")
}
Output: {
  ok: boolean;
}
```

### C.2 Read Tools

#### `slack_list_channels`

List public channels in the workspace.

```typescript
Input: {
  limit?: number;        // Default: 100, Max: 200
  cursor?: string;       // Pagination cursor
}
Output: {
  channels: Array<{ id: string; name: string; is_member: boolean }>;
  next_cursor?: string;
}
```

#### `slack_get_channel_history`

Get recent messages from a channel.

```typescript
Input: {
  channel_id: string;    // Required
  limit?: number;        // Default: 10
}
Output: {
  messages: Array<{
    user: string;
    text: string;
    ts: string;
    thread_ts?: string;
  }>;
}
```

#### `slack_get_thread_replies`

Get all replies in a message thread.

```typescript
Input: {
  channel_id: string;    // Required
  thread_ts: string;     // Required. Parent message timestamp
  limit?: number;        // Default: 50
}
Output: {
  messages: Array<{
    user: string;
    text: string;
    ts: string;
  }>;
}
```

### C.3 Custom Tools

#### `slack_ask`

Post a question to Slack and wait for a human reply. Combines post + poll.

```typescript
Input: {
  channel_id: string;    // Required. Channel to post in
  question: string;      // Required. Question text
  mention?: string;      // Optional. User mention (e.g. "<@U123>")
  timeout_seconds?: number; // Default: 120. Max wait time
}
Output: {
  answered: boolean;
  reply_text?: string;   // Human's reply (if answered)
  user_id?: string;      // Who replied
  reply_ts?: string;     // Reply timestamp
  thread_ts: string;     // Parent message timestamp (for follow-ups)
}
```

Implementation:
1. Post message with mention (if provided)
2. Poll `conversations.replies` every 3 seconds
3. Filter replies: skip bot messages, require authorized user
4. Return first matching reply or timeout

#### `slack_check_reply`

Non-blocking check for new thread replies. For manual polling pattern.

```typescript
Input: {
  channel_id: string;    // Required
  thread_ts: string;     // Required. Thread to check
  after_ts?: string;     // Only replies after this timestamp
}
Output: {
  has_reply: boolean;
  replies: Array<{
    user_id: string;
    text: string;
    ts: string;
  }>;
}
```

#### `slack_register_session`

Register a Slack thread → tmux pane mapping for inbound reply injection.

```typescript
Input: {
  channel_id: string;    // Required
  thread_ts: string;     // Required. Parent message timestamp
  tmux_pane_id: string;  // Required. tmux pane ID (e.g. "%5")
  session_id?: string;   // Optional. Claude session ID
  project_path?: string; // Optional. Project directory
}
Output: {
  ok: boolean;
  message_id: string;    // Composite key: "{channelId}:{thread_ts}"
}
```

#### `slack_get_session`

Lookup session mapping by Slack thread.

```typescript
Input: {
  channel_id: string;    // Required
  thread_ts: string;     // Required
}
Output: {
  found: boolean;
  tmux_pane_id?: string;
  session_id?: string;
  project_path?: string;
  created_at?: string;
}
```

---

## D. Background Socket Mode Listener

### D.1 Lifecycle

The Socket Mode listener starts when the MCP server initializes and runs for the entire server lifetime.

```typescript
// In MCP server initialization
const app = new App({
  token: SLACK_BOT_TOKEN,       // xoxb-*
  appToken: SLACK_APP_TOKEN,    // xapp-*
  socketMode: true,
});

// Resolve bot user ID for self-loop prevention
const authResult = await app.client.auth.test();
const botUserId = authResult.user_id;

// Register message handler
app.message(async ({ message, client }) => {
  // ... filtering and injection logic (see B.2)
});

await app.start();
```

### D.2 Message Filtering (4 Layers)

```typescript
// 1. Plain messages only (skip bot_message, message_changed, etc.)
if ("subtype" in message && message.subtype !== undefined) return;

// 2. Thread replies only (not top-level messages)
if (!message.thread_ts || message.thread_ts === message.ts) return;

// 3. Self-loop prevention (skip bot's own messages)
if (message.user === botUserId) return;

// 4. Authorization (only whitelisted users)
if (!authorizedUserIds.includes(message.user)) return;
```

### D.3 Reply Injection

```typescript
import { execSync } from "child_process";

function injectReply(paneId: string, text: string): boolean {
  // Sanitize input
  const sanitized = text
    .replace(/[\x00-\x1f\x7f]/g, "")     // Strip control characters
    .replace(/[`$(){}\\]/g, "\\$&");       // Escape shell metacharacters

  try {
    execSync(`tmux send-keys -t ${paneId} ${shellQuote(sanitized)} Enter`, {
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}
```

### D.4 Error Isolation

Socket Mode failures must never crash the MCP server:

```typescript
try {
  await app.start();
} catch (error) {
  console.error(`[omc-slack-mcp] Socket Mode failed to start: ${error}`);
  // MCP tools still work (outbound-only mode)
  // Inbound replies won't be auto-injected, but slack_check_reply still works
}
```

---

## E. Session Registry

### E.1 Format

In-memory Map with JSONL persistence at `~/.omc/state/slack-session-registry.jsonl`.

```typescript
interface SessionEntry {
  messageId: string;       // "{channelId}:{thread_ts}" composite key
  channelId: string;
  threadTs: string;
  tmuxPaneId: string;
  sessionId?: string;
  projectPath?: string;
  createdAt: string;       // ISO 8601
}
```

### E.2 Operations

```typescript
// Register: append to JSONL + update in-memory map
function register(entry: SessionEntry): void;

// Lookup: O(1) in-memory map lookup
function lookup(channelId: string, threadTs: string): SessionEntry | null;

// Prune: remove entries older than TTL (default 24h)
function prune(ttlMs?: number): number;
```

### E.3 Composite Key

```
{channelId}:{thread_ts}
```

Example: `C07ABC123:1709312345.123456`

- `channelId`: C-prefixed (public) or D-prefixed (DM)
- `thread_ts`: Slack message timestamp (unique per channel)
- Separator `:` is safe — neither field contains colons

### E.4 Persistence

- **Write**: Append-only JSONL (one line per entry)
- **Read on startup**: Load JSONL into in-memory Map, auto-prune stale entries
- **No concurrent writers**: Single MCP server process owns the file

---

## F. Configuration

### F.1 MCP Server Registration

**File: `~/.claude/.mcp.json`** (or project-level `.mcp.json`)

```json
{
  "mcpServers": {
    "slack": {
      "command": "node",
      "args": ["/path/to/omc-slack-mcp/dist/index.js"],
      "env": {
        "SLACK_BOT_TOKEN": "xoxb-...",
        "SLACK_APP_TOKEN": "xapp-...",
        "SLACK_DEFAULT_CHANNEL_ID": "C07ABC123",
        "SLACK_AUTHORIZED_USER_IDS": "U0DEVELOPER",
        "SLACK_MENTION": "<@U0DEVELOPER>"
      }
    }
  }
}
```

### F.2 Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SLACK_BOT_TOKEN` | Phase 1 | Bot token (`xoxb-*`) |
| `SLACK_APP_TOKEN` | Phase 2 | App-level token (`xapp-*`, scope: `connections:write`) |
| `SLACK_DEFAULT_CHANNEL_ID` | Yes | Default channel for notifications |
| `SLACK_AUTHORIZED_USER_IDS` | Phase 2 | Comma-separated authorized user IDs |
| `SLACK_MENTION` | No | Default mention prefix (e.g. `<@U123>`) |
| `SLACK_REGISTRY_PATH` | No | Custom registry path (default: `~/.omc/state/slack-session-registry.jsonl`) |
| `SLACK_ASK_TIMEOUT` | No | Default timeout for `slack_ask` in seconds (default: 120) |

### F.3 Slack App Dashboard Setup

Required Bot Token Scopes:

| Scope | Purpose | Phase |
|-------|---------|-------|
| `chat:write` | Post messages | 1 |
| `channels:read` | List channels | 1 |
| `channels:history` | Read channel messages, poll replies | 1 |
| `reactions:write` | Add confirmation reactions | 1 |
| `users:read` | Get user info | 1 |
| `connections:write` | Socket Mode | 2 |

Required Event Subscriptions (Phase 2):

| Event | Purpose |
|-------|---------|
| `message.channels` | Receive thread replies in public channels |

---

## G. Security

| Layer | Mechanism |
|-------|-----------|
| User authorization | `SLACK_AUTHORIZED_USER_IDS` whitelist. Empty = inbound disabled |
| Input sanitization | Strip control chars (`\x00-\x1f`), escape `$(){}\\`` ` before tmux injection |
| Token storage | Environment variables only (never written to files by the server) |
| Self-loop prevention | `auth.test` resolves bot user ID at startup, filter `msg.user === botUserId` |
| Pane validation | Verify tmux pane exists before injection (`tmux has-session`) |
| Rate limiting | Max 10 injections/minute (configurable) |
| Message length | Truncate at 4,000 chars (Slack API limit for text field) |

---

## H. Package Structure

```
omc-slack-mcp/
├── package.json            # @omc/slack-mcp, type: "module"
├── tsconfig.json           # strict, ESM, outDir: dist
├── .env.example            # documented env vars
├── .gitignore
├── src/
│   ├── index.ts            # MCP server entry (STDIO transport)
│   ├── config.ts           # Env var parsing and validation
│   ├── tools/
│   │   ├── messaging.ts    # post_message, reply_to_thread, add_reaction
│   │   ├── channels.ts     # list_channels, get_history, get_thread_replies
│   │   └── ask.ts          # slack_ask, slack_check_reply (custom)
│   ├── session/
│   │   ├── registry.ts     # In-memory + JSONL session registry
│   │   └── tools.ts        # register_session, get_session MCP tools
│   ├── listener/
│   │   ├── socket-mode.ts  # @slack/bolt Socket Mode background listener
│   │   └── injector.ts     # tmux send-keys injection + sanitization
│   └── slack/
│       └── client.ts       # WebClient singleton + auth.test validation
└── tests/
    ├── messaging.test.ts
    ├── ask.test.ts
    ├── channels.test.ts
    ├── registry.test.ts
    ├── injector.test.ts
    └── config.test.ts
```

---

## I. Implementation Phases

### Phase 1: Outbound (MCP Tools)

Claude can post messages to Slack and register sessions.

| Step | File | Description | Complexity |
|------|------|-------------|-----------|
| 1 | `package.json`, `tsconfig.json` | Project init, dependencies | Trivial |
| 2 | `src/config.ts` | Env var parsing, token validation | Low |
| 3 | `src/slack/client.ts` | WebClient singleton, auth.test | Low |
| 4 | `src/index.ts` | MCP server scaffold (STDIO) | Low |
| 5 | `src/tools/messaging.ts` | post_message, reply_to_thread, add_reaction | Medium |
| 6 | `src/tools/channels.ts` | list_channels, get_history, get_thread_replies | Medium |
| 7 | `src/tools/ask.ts` | slack_ask (post + poll), slack_check_reply | Medium |
| 8 | `src/session/registry.ts` | In-memory Map + JSONL persistence | Medium |
| 9 | `src/session/tools.ts` | register_session, get_session MCP tools | Low |
| 10 | `tests/*` | Unit tests for all tools | Medium |
| 11 | `.mcp.json` | Register with Claude Code | Trivial |
| 12 | Manual verification | Real Slack message test | — |

**Dependencies**: `@modelcontextprotocol/sdk`, `@slack/web-api`, `zod`
**Dev dependencies**: `typescript`, `vitest`, `tsx`, `@types/node`

### Phase 2: Inbound (Socket Mode Listener)

Slack thread replies are auto-injected into Claude Code sessions.

| Step | File | Description | Complexity |
|------|------|-------------|-----------|
| 13 | `package.json` | Add `@slack/bolt` | Trivial |
| 14 | `src/listener/injector.ts` | tmux send-keys injection + sanitization | Medium |
| 15 | `src/listener/socket-mode.ts` | Bolt App init, message handler, filtering | High |
| 16 | `src/index.ts` | Start Socket Mode on server init | Low |
| 17 | `tests/injector.test.ts` | Injection tests, sanitization | Medium |
| 18 | `tests/socket-mode.test.ts` | Handler filtering, self-loop, error isolation | High |
| 19 | Manual verification | Slack reply → tmux injection | — |

### Phase 3: DM & @Mention (Future)

| Scope | Description |
|-------|-------------|
| DM handler | `channel_type === "im"` → find active session → inject |
| @Mention handler | `app.event("app_mention")` → strip mention → inject |
| Scopes needed | `im:history`, `im:read`, `app_mentions:read` |
| Events needed | `message.im`, `app_mention` |

### Phase 4: Response Capture (Future)

| Scope | Description |
|-------|-------------|
| tmux output monitoring | Poll tmux pane for Claude's response |
| Response parsing | Extract meaningful output from pane content |
| Thread posting | Post response back to Slack thread |

---

## J. Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Socket Mode disconnect | Medium | @slack/bolt auto-reconnects (~5s). Lost events acceptable |
| MCP server restart → Socket Mode reconnects | Medium | Bolt reconnects automatically on restart |
| Claude forgets to call slack tools | Medium | Configure in CLAUDE.md or skill prompts to remind |
| 120s slack_ask timeout too short | Low | Configurable timeout. Fallback: slack_check_reply polling |
| JSONL registry grows unbounded | Low | 24h TTL auto-prune on startup |
| tmux pane closed → injection fails | Low | Verify pane exists before send-keys. Silently skip |
| Concurrent Socket Mode + tool calls | Low | WebClient is thread-safe. Registry uses single-writer pattern |
| Slack rate limits (chat.postMessage) | Low | ~1 msg/sec/channel limit. OMC notifications are infrequent |

---

## K. Comparison with Previous Approaches

| Aspect | v1: Standalone Daemon | v3: OMC Core Integration | v4: MCP Server (current) |
|--------|----------------------|--------------------------|--------------------------|
| OMC changes | None (HTTPS issue) | 6 files | **None** |
| External dependency | OpenClaw or mkcert | None | **None** |
| Process management | Manual daemon | Built into OMC | **Auto (Claude Code)** |
| Claude tool access | None | None | **Native MCP tools** |
| Outbound trigger | Webhook push | OMC dispatcher | **Claude calls directly** |
| Inbound mechanism | Socket Mode daemon | OMC reply-listener | **Socket Mode in MCP** |
| Update resilience | Independent | Breaks on OMC update | **Independent** |

---

## L. References

- [MCP Server SDK](https://modelcontextprotocol.io/docs/develop/build-server) — Official build guide
- [@modelcontextprotocol/server-slack](https://github.com/modelcontextprotocol/servers/tree/main/src/slack) — Reference implementation
- [trtd56/AskOnSlackMCP](https://github.com/trtd56/AskOnSlackMCP) — Human-in-the-loop Slack MCP (ask + wait pattern)
- [Slack Bolt for JavaScript](https://docs.slack.dev/tools/bolt-js/getting-started/) — Socket Mode framework
- [Slack chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/) — API reference
- [Slack Rate Limits](https://docs.slack.dev/apis/web-api/rate-limits/) — API constraints
