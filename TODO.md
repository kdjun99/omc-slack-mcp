# omc-slack-mcp — TODO

> Architecture: ARCHITECTURE.md (v4) — Standalone MCP Server approach
> No OMC core modifications. No OpenClaw dependency.
> Previous versions: ARCHITECTURE.md.v3.deprecated, ARCHITECTURE.md.deprecated, PLAN.md.deprecated

---

## Slack App Dashboard Setup

- [x] Socket Mode enabled
- [x] App-Level Token created (`xapp-...`, scope: `connections:write`)
- [x] Bot Token Scopes configured
  - [x] `chat:write`
  - [x] `channels:history`
  - [x] `reactions:write`
  - [x] `channels:manage`
  - [x] `incoming-webhook` (legacy)
- [x] Event Subscriptions enabled
  - [x] `message.channels`
- [x] App reinstalled to workspace
- [x] Token verification tests passed
  - [x] `auth.test` — Bot User ID: `U0AHJ1FMX3M`
  - [x] `conversations.create`
  - [x] `chat.postMessage` — `ts` return confirmed
- [ ] Add `channels:read` scope (for `slack_list_channels`)
- [ ] Add `users:read` scope (for user resolution)
- [ ] Get your own Slack User ID (Profile > More > Copy member ID)

---

## Phase 1: Outbound (MCP Tools)

> **Goal:** Claude can post messages to Slack via MCP tools
> **Approach:** Standalone MCP server with @slack/web-api

### Step 1: Project Init ✅
- [x] `package.json`: name `omc-slack-mcp`, `type: "module"`, `bin`
- [x] Dependencies: `@modelcontextprotocol/sdk`, `@slack/web-api`, `zod`
- [x] Dev dependencies: `typescript`, `vitest`, `tsx`, `@types/node`
- [x] `tsconfig.json`: strict, ESM, `outDir: "dist"`
- [x] `.gitignore`: node_modules, dist, .env
- [x] `.env.example`: documented env vars

### Step 2: Config (`src/config.ts`)
- [ ] Parse env vars: `SLACK_BOT_TOKEN`, `SLACK_DEFAULT_CHANNEL_ID`, `SLACK_MENTION`
- [ ] Validate bot token format (`xoxb-*`)
- [ ] Optional: `SLACK_ASK_TIMEOUT`, `SLACK_REGISTRY_PATH`
- [ ] Export typed config object

### Step 3: Slack Client (`src/slack/client.ts`)
- [ ] `initClient(botToken)` → WebClient singleton
- [ ] `auth.test()` call to validate token and resolve bot user ID
- [ ] Export `getClient()`, `getBotUserId()`

### Step 4: MCP Server Scaffold (`src/index.ts`)
- [ ] Create McpServer instance (name: `omc-slack-mcp`)
- [ ] STDIO transport setup
- [ ] Load config, init Slack client on startup
- [ ] Register all tools
- [ ] Error handling (stderr logging, never stdout)

### Step 5: Messaging Tools (`src/tools/messaging.ts`)
- [ ] `slack_post_message(channel_id, text)` → `{ ok, ts, channel }`
- [ ] `slack_reply_to_thread(channel_id, thread_ts, text)` → `{ ok, ts }`
- [ ] `slack_add_reaction(channel_id, timestamp, reaction)` → `{ ok }`

### Step 6: Channel/Read Tools (`src/tools/channels.ts`)
- [ ] `slack_list_channels(limit?, cursor?)` → channels list
- [ ] `slack_get_channel_history(channel_id, limit?)` → messages list
- [ ] `slack_get_thread_replies(channel_id, thread_ts, limit?)` → replies list

### Step 7: Ask Tools (`src/tools/ask.ts`)
- [ ] `slack_ask(channel_id, question, mention?, timeout_seconds?)` → `{ answered, reply_text, ... }`
  - [ ] Post message with optional @mention
  - [ ] Poll `conversations.replies` every 3 seconds
  - [ ] Filter: skip bot messages, require authorized user
  - [ ] Return first reply or timeout
- [ ] `slack_check_reply(channel_id, thread_ts, after_ts?)` → `{ has_reply, replies }`

### Step 8: Session Registry (`src/session/registry.ts`)
- [ ] `SessionEntry` interface: messageId, channelId, threadTs, tmuxPaneId, sessionId, projectPath, createdAt
- [ ] In-memory Map (primary store) + JSONL persistence
- [ ] `register(entry)` → append to JSONL + update Map
- [ ] `lookup(channelId, threadTs)` → O(1) Map lookup
- [ ] `prune(ttlMs)` → remove entries older than TTL (default 24h)
- [ ] Load JSONL into Map on startup

### Step 9: Session Tools (`src/session/tools.ts`)
- [ ] `slack_register_session(channel_id, thread_ts, tmux_pane_id, session_id?, project_path?)` → `{ ok, message_id }`
- [ ] `slack_get_session(channel_id, thread_ts)` → `{ found, tmux_pane_id, ... }`

### Step 10: Tests
- [ ] `messaging.test.ts` — mock WebClient, post/reply/reaction, error paths
- [ ] `channels.test.ts` — list channels, get history, get thread replies
- [ ] `ask.test.ts` — post + poll cycle, timeout, authorized user filter
- [ ] `registry.test.ts` — register, lookup, prune, JSONL persistence
- [ ] `config.test.ts` — env parsing, token validation, defaults

### Step 11: MCP Registration
- [ ] Create `.mcp.json` example for Claude Code
- [ ] Document setup in README

### Step 12: Verification (Manual)
- [ ] MCP server starts via Claude Code
- [ ] `slack_post_message` sends message to Slack
- [ ] `slack_ask` posts question, receives reply
- [ ] `slack_register_session` stores mapping
- [ ] `slack_get_session` retrieves mapping
- [ ] `slack_list_channels` returns workspace channels

---

## Phase 2: Inbound (Socket Mode Listener)

> **Goal:** Slack thread replies auto-injected into Claude Code tmux sessions
> **Approach:** @slack/bolt Socket Mode running as background process in MCP server

### Step 13: Dependencies
- [ ] Add `@slack/bolt` to `package.json`

### Step 14: Reply Injector (`src/listener/injector.ts`)
- [ ] `sanitizeInput(text)` — strip control chars, escape shell metacharacters
- [ ] `injectReply(paneId, text)` — `tmux send-keys` with sanitized input
- [ ] `verifyPane(paneId)` — check tmux pane exists
- [ ] Rate limiter (max 10 injections/minute)

### Step 15: Socket Mode Listener (`src/listener/socket-mode.ts`)
- [ ] `initSocketMode(config, registry)` → start Bolt App
- [ ] Bolt App creation with Socket Mode (`appToken`)
- [ ] `auth.test` for bot user ID resolution (self-loop prevention)
- [ ] Message handler with 4-layer filtering:
  - [ ] Subtype filter (plain messages only)
  - [ ] Thread reply filter (`thread_ts` exists, `thread_ts !== ts`)
  - [ ] Self-loop filter (`user !== botUserId`)
  - [ ] Authorization filter (`user in authorizedUserIds`)
- [ ] Session registry lookup → tmux pane ID
- [ ] `injectReply()` call
- [ ] `reactions.add("white_check_mark")` confirmation
- [ ] Error isolation (try/catch, no process.exit)

### Step 16: Integration (`src/index.ts`)
- [ ] Start Socket Mode listener on MCP server init (after client validation)
- [ ] Graceful shutdown on SIGTERM (`app.stop()`)
- [ ] Fallback: MCP tools still work if Socket Mode fails to start

### Step 17: Tests
- [ ] `injector.test.ts` — sanitization, shell escaping, pane verification
- [ ] `socket-mode.test.ts` — 4-layer filtering, registry lookup, injection, error isolation
- [ ] Bot self-loop prevention test
- [ ] Socket Mode failure does not crash MCP server

### Step 18: Verification (Manual)
- [ ] Slack thread reply → text injected into Claude Code tmux session
- [ ] Checkmark reaction added on successful injection
- [ ] Socket Mode disconnect → auto-reconnect → events resume
- [ ] MCP tools still work when Socket Mode is down

---

## Phase 3: DM & @Mention (Future)

> **Goal:** Send commands via DM or @mention without thread context

### Slack Dashboard
- [ ] Add `im:history`, `im:read`, `app_mentions:read` scopes
- [ ] Add `message.im`, `app_mention` events
- [ ] Reinstall app

### Implementation
- [ ] DM handler in Bolt App
- [ ] @mention handler in Bolt App
- [ ] `findActiveSession()` for session lookup without thread context
- [ ] Tests

---

## Phase 4: Response Capture (Future)

> **Goal:** Post Claude's response back to Slack thread

- [ ] tmux pane output monitoring design
- [ ] Response parsing + formatting
- [ ] Post to Slack thread via `slack_reply_to_thread` with `thread_ts`
