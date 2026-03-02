# OMC Slack Bidirectional Interface - Architecture Design

## Context

OMC (oh-my-claudecode) currently supports one-way Slack notifications via Incoming Webhooks. Discord and Telegram already have bidirectional communication through `reply-listener.ts`, enabling users to reply to notifications and have those replies injected into active Claude Code sessions.

This document designs the architecture for extending Slack to support bidirectional communication, allowing users to interact with Claude Code directly from Slack.

---

## Current Architecture

### Forward Path (Outbound Notifications)

```
Hook Event → notify() → formatNotification() → dispatchNotifications()
                              │                        │
                              ├─ Discord (webhook)     ├─ sendDiscord()
                              ├─ Discord Bot (API)     ├─ sendDiscordBot() → returns messageId
                              ├─ Telegram (API)        ├─ sendTelegram()  → returns messageId
                              ├─ Slack (webhook)       ├─ sendSlack()     → NO messageId
                              └─ Generic webhook       └─ sendWebhook()
```

### Reverse Path (Inbound Replies - Discord/Telegram only)

```
Reply Listener Daemon (background Node.js process)
  │
  ├─ pollDiscord()  → Discord API GET /channels/{id}/messages
  │   └─ Filter: reply_to_message + authorized user
  │
  ├─ pollTelegram() → Telegram API getUpdates (long poll)
  │   └─ Filter: reply_to_message + chat_id match
  │
  └─ [NEW] pollSlack() → Slack Socket Mode or conversations.replies
      └─ Filter: thread_ts match + authorized user

On matched reply:
  1. lookupByMessageId(platform, messageId) → session mapping
  2. Verify tmux pane is alive (capturePaneContent + analyzePaneContent)
  3. sanitizeReplyInput(text) → escape control chars, backticks, $()
  4. sendToPane(paneId, sanitizedText) → tmux send-keys
```

### Session Registry

```
~/.omc/state/reply-session-registry.jsonl
  ├─ Format: Line-delimited JSON (one mapping per line)
  ├─ Lock: O_EXCL file lock with stale detection
  ├─ Prune: 24-hour TTL, hourly cleanup
  └─ Mapping: { platform, messageId, sessionId, tmuxPaneId, ... }
```

---

## Proposed Architecture

### Option A: Socket Mode (Recommended)

```
┌─────────────────────────────────────────────────────────────┐
│                    Slack Workspace                           │
│  ┌─────────────┐     ┌───────────────┐    ┌──────────────┐ │
│  │ #claude-code │     │ DM with OMC   │    │ Thread Reply │ │
│  │   channel    │     │   bot         │    │   to notif   │ │
│  └──────┬───────┘     └───────┬───────┘    └──────┬───────┘ │
└─────────┼─────────────────────┼───────────────────┼─────────┘
          │                     │                   │
          └─────────────────────┼───────────────────┘
                                │ WebSocket (Socket Mode)
                                │
┌───────────────────────────────┴─────────────────────────────┐
│        OMC Reply Listener Daemon (integrated)               │
│                                                             │
│  ┌──────────────────┐  ┌──────────────────┐                │
│  │ Slack Socket Mode│  │ Slack Message     │                │
│  │ Client           │──│ Router            │                │
│  │ (@slack/bolt)    │  │ ├─ Thread reply  │──→ injectReply │
│  └──────────────────┘  │ ├─ DM command    │──→ injectReply │
│                        │ └─ @mention      │──→ injectReply │
│  ┌──────────────────┐  └──────────────────┘                │
│  │ Poll Loop        │                                       │
│  │ ├─ pollDiscord() │──────────────────────→ injectReply   │
│  │ └─ pollTelegram()│──────────────────────→ injectReply   │
│  └──────────────────┘                                       │
│                                                             │
│  ┌──────────────────┐  ┌──────────────────┐                │
│  │ Session Registry │  │ Response         │                │
│  │ Lookup           │  │ Sender           │                │
│  │ (JSONL)          │  │ (chat.postMessage│                │
│  └──────────────────┘  │  in thread)      │                │
│                        └──────────────────┘                │
└─────────────────────────────────────────────────────────────┘
          │                              │
          ▼                              ▼
┌──────────────────┐          ┌──────────────────┐
│ tmux Session     │          │ Slack API        │
│ (Claude Code)    │          │ (chat.postMessage│
│                  │          │  reactions.add)  │
│ send-keys →      │          └──────────────────┘
│ inject user text │
└──────────────────┘
```

**Pros:**
- Real-time message delivery (no polling delay)
- No public URL required (works behind firewalls)
- Clean WebSocket connection management via Bolt SDK
- Handles reconnection automatically

**Cons:**
- Persistent WebSocket connection (more resource usage than polling)
- Requires app-level token (xapp-*) in addition to bot token
- Slightly more complex daemon lifecycle

### Option B: HTTP Polling (conversations.replies)

```
Reply Listener Daemon (existing pollLoop)
  │
  ├─ pollDiscord()
  ├─ pollTelegram()
  └─ pollSlack()
       │
       ├─ For each registered Slack message (from session registry):
       │   GET conversations.replies(channel, ts=messageTs, oldest=lastCheckedTs)
       │   └─ Filter new replies from authorized users
       │
       └─ Inject matched replies via injectReply()
```

**Pros:**
- Minimal architecture change (fits existing poll loop pattern)
- No persistent connection needed
- Simpler daemon lifecycle

**Cons:**
- Slack severely rate-limits conversations.replies (1 req/min for non-Marketplace apps)
- High latency (poll interval + rate limit = 60s+ delay)
- Scales poorly with many tracked messages
- Not suitable for interactive conversation

### Decision: Option A (Socket Mode)

Socket Mode is strongly preferred because:
1. Interactive use requires low latency (<1s vs 60s+)
2. Slack's rate limits make polling impractical for conversation
3. Bolt SDK handles all complexity (reconnection, ack, retries)
4. No public URL needed for local development

---

## Component Design

### 1. Slack App Configuration (Slack Dashboard)

**App Settings Required:**

| Setting | Value | Purpose |
|---------|-------|---------|
| App Name | `OMC` | Display name in Slack |
| Bot User | `OMC` | Already configured |
| Socket Mode | Enabled | WebSocket connection |
| Event Subscriptions | Enabled | Receive events |

**Required Bot Token Scopes (xoxb-*):**

| Scope | Phase | Purpose |
|-------|-------|---------|
| `chat:write` | 1 | Send messages and thread replies |
| `channels:history` | 2 | Read channel messages (for thread replies) |
| `reactions:write` | 2 | Add checkmark reactions on successful injection |
| `channels:manage` | 1* | Create channels automatically (*only if `autoCreateChannels: true`) |
| `app_mentions:read` | 3 | Detect @OMC mentions in channels |
| `im:history` | 3 | Read DM message history |
| `im:read` | 3 | Access DM conversations |

**App-Level Token Scope (xapp-*):**

| Scope | Purpose |
|-------|---------|
| `connections:write` | Socket Mode WebSocket connection |

**Event Subscriptions (bot events):**

| Event | Trigger |
|-------|---------|
| `message.im` | DM to bot |
| `app_mention` | @OMC in a channel |
| `message.channels` | Messages in channels bot is in (for thread detection) |

### 2. Type System Integration

**File:** `src/notifications/types.ts`

The following type changes are required across the codebase for `"slack-bot"` to compile and function:

```typescript
// types.ts:22-27 - Add "slack-bot" to platform union
export type NotificationPlatform =
  | "discord"
  | "discord-bot"
  | "telegram"
  | "slack"
  | "slack-bot"    // NEW: Bot API with message ID tracking
  | "webhook";
```

**File:** `src/notifications/session-registry.ts`

```typescript
// session-registry.ts:81-90 - Add "slack-bot" to SessionMapping.platform
interface SessionMapping {
  platform: "discord-bot" | "telegram" | "slack-bot";  // Add slack-bot
  // ... rest unchanged
}
```

**File:** `src/notifications/dispatcher.ts`

```typescript
// dispatcher.ts:521-584 - Add slack-bot branch to dispatchNotifications()
// Inside the platform dispatch switch/if chain:
if (config.slackBot?.enabled) {
  promises.push(sendSlackBot(config.slackBot, payload));
}
```

**File:** `src/notifications/index.ts`

```typescript
// index.ts:217-219 - Extend message ID registration condition
if (r.success && r.messageId &&
    (r.platform === "discord-bot" || r.platform === "telegram" || r.platform === "slack-bot")) {
  await registerMessage({ platform: r.platform, messageId: r.messageId, ... });
}
```

### 3. Config Extension

**File:** `src/notifications/config.ts`

```typescript
// New Slack Bot config (alongside existing webhook config)
interface SlackBotNotificationConfig {
  enabled: boolean;
  botToken: string;          // xoxb-... (Bot User OAuth Token)
  appToken: string;          // xapp-... (App-Level Token for Socket Mode)
  channelId?: string;        // Default/fallback channel for notifications
  channelRouting?: ChannelRoute[];  // Project-to-channel routing rules (explicit)
  autoCreateChannels?: boolean;     // Auto-create channels for unmatched projects
  channelPrefix?: string;          // Prefix for auto-created channels (default: "omc")
  mention?: string;          // Slack mention format
  username?: string;         // Display name override
}

// Project-to-channel routing rule
interface ChannelRoute {
  pathPattern: string;       // Substring match against projectPath (e.g., "linkareer-main")
  channelId: string;         // Slack channel ID to send notifications to
}

// Reply config extension
interface ReplyConfig {
  // ... existing fields ...
  authorizedSlackUserIds: string[];  // Slack user IDs (UXXXXXXXX)
}
```

**Required Bot Token Scope for auto-create:**

| Scope | Purpose |
|-------|---------|
| `channels:manage` | Create public channels via `conversations.create` |

Add this scope in **OAuth & Permissions** if `autoCreateChannels` is enabled.

**Channel Resolution** (3-tier priority):

```
1. channelRouting  → Explicit pathPattern match (first match wins)
2. autoCreateChannels → Derive channel name from projectPath, create if missing
3. channelId       → Fallback default channel
```

```typescript
import { WebClient } from '@slack/web-api';

/**
 * Resolve target channel based on project path.
 * Priority: explicit routing > auto-create > fallback channelId.
 */
async function resolveOrCreateChannel(
  client: WebClient,
  config: SlackBotNotificationConfig,
  projectPath?: string
): Promise<string> {
  // 1. Explicit routing rules (first match wins)
  if (projectPath && config.channelRouting) {
    for (const route of config.channelRouting) {
      if (projectPath.includes(route.pathPattern)) {
        return route.channelId;
      }
    }
  }

  // 2. Auto-create channel from project name
  if (projectPath && config.autoCreateChannels) {
    const channelName = deriveChannelName(projectPath, config.channelPrefix);

    // Check if channel already exists
    const existing = await findChannelByName(client, channelName);
    if (existing) return existing;

    // Create new channel
    try {
      const result = await client.conversations.create({ name: channelName });
      if (result.ok && result.channel) {
        // Cache the channelId to avoid repeated API calls
        await cacheChannelRoute(projectPath, result.channel.id);
        return result.channel.id;
      }
    } catch (err) {
      // Channel creation failed (e.g., name taken, permissions) — fall through to default
      log(`Auto-create channel "${channelName}" failed: ${err.message}`);
    }
  }

  // 3. Fallback default
  return config.channelId;
}

/**
 * Derive Slack channel name from project path.
 * Slack channel names: lowercase, max 80 chars, only letters/numbers/hyphens.
 *
 * Examples:
 *   ~/dev/linkareer/linkareer-main  → "omc-linkareer-main"
 *   ~/dev/my_cool_project           → "omc-my-cool-project"
 */
function deriveChannelName(projectPath: string, prefix?: string): string {
  const dirName = path.basename(projectPath);
  const p = prefix || 'omc';
  return `${p}-${dirName}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')  // Replace invalid chars with hyphens
    .replace(/-+/g, '-')           // Collapse consecutive hyphens
    .replace(/^-|-$/g, '')         // Trim leading/trailing hyphens
    .slice(0, 80);                 // Slack max channel name length
}

/**
 * Find existing channel by name.
 * Uses conversations.list with types=public_channel.
 */
async function findChannelByName(client: WebClient, name: string): Promise<string | null> {
  // Note: For workspaces with many channels, this may require pagination.
  // Consider caching results to avoid repeated API calls.
  const result = await client.conversations.list({
    types: 'public_channel',
    exclude_archived: true,
    limit: 1000,
  });
  const channel = result.channels?.find(c => c.name === name);
  return channel?.id || null;
}

/**
 * Cache auto-created channel mapping to avoid repeated conversations.list calls.
 * Persists to ~/.omc/state/slack-channel-cache.json
 */
async function cacheChannelRoute(projectPath: string, channelId: string): Promise<void> {
  // Simple JSON file cache: { "projectPath": "channelId", ... }
  // Read → merge → write with 0600 permissions
}
```

Example routing:

```
~/dev/linkareer/linkareer-main  → channelRouting match  → #linkareer-main   (C_MAIN)
~/dev/linkareer/linkareer-admin → channelRouting match  → #linkareer-admin   (C_ADMIN)
~/dev/new-project               → autoCreateChannels    → #omc-new-project   (auto-created)
~/dev/another-project           → autoCreateChannels    → #omc-another-project (auto-created)
(no projectPath)                → fallback              → #omc-notifications (channelId)
```

**Channel cache:** Auto-created channel IDs are cached in `~/.omc/state/slack-channel-cache.json` to avoid repeated `conversations.list` calls. The cache is a simple `{ projectPath: channelId }` map.

**Inbound reply routing is automatic** — the composite key `{channelId}:{ts}` already encodes which channel the notification was sent to, so thread replies in any channel (whether manually configured or auto-created) are correctly routed back to the originating session.

**Token format validation** (add to config validation):

```typescript
// Validate Slack bot token format (xoxb-*)
function validateSlackBotToken(token: string): boolean {
  return /^xoxb-[0-9]+-[0-9]+-[A-Za-z0-9]+$/.test(token);
}

// Validate Slack app token format (xapp-*)
function validateSlackAppToken(token: string): boolean {
  return /^xapp-[0-9]+-[A-Z0-9]+-[a-f0-9]+$/.test(token);
}
```

**`getReplyConfig()` extension** (critical for Slack-only users):

```typescript
// config.ts:706-716 - Currently returns null unless Discord or Telegram is enabled.
// MUST be extended to recognize slack-bot:
const hasSlackBot = !!getEnabledReplyPlatformConfig<SlackBotNotificationConfig>(notifConfig, "slack-bot");
if (!hasDiscordBot && !hasTelegram && !hasSlackBot) return null;
```

Without this change, users who only configure Slack (no Discord/Telegram) will get `null` from `getReplyConfig()`, silently preventing the reply listener from starting.

**Environment Variables:**

| Variable | Example | Purpose |
|----------|---------|---------|
| `OMC_SLACK_BOT_TOKEN` | `xoxb-...` | Bot token |
| `OMC_SLACK_APP_TOKEN` | `xapp-...` | App-level token for Socket Mode |
| `OMC_SLACK_CHANNEL_ID` | `C0123456789` | Default/fallback notification channel |
| `OMC_SLACK_CHANNEL_ROUTING` | `linkareer-main:C_MAIN,...` | Explicit project-to-channel routing |
| `OMC_SLACK_AUTO_CREATE_CHANNELS` | `true` | Auto-create channels for new projects |
| `OMC_SLACK_CHANNEL_PREFIX` | `omc` | Prefix for auto-created channels (default: `omc`) |
| `OMC_REPLY_SLACK_USER_IDS` | `U123,U456` | Authorized Slack user IDs |

### 4. Outbound: sendSlackBot()

**File:** `src/notifications/dispatcher.ts`

New function alongside existing `sendSlack()` (webhook):

```typescript
export async function sendSlackBot(
  config: SlackBotNotificationConfig,
  payload: NotificationPayload
): Promise<NotificationResult> {
  // 1. Validate config (botToken, at least channelId or channelRouting)
  // 2. Resolve target channel: resolveChannel(config, payload.projectPath)
  // 3. Convert markdown to Slack mrkdwn (reuse markdownToSlackMrkdwn)
  // 4. POST chat.postMessage via Slack Web API
  //    - channel: resolvedChannelId
  //    - text: formatted message
  //    - mrkdwn: true
  // 5. Extract `ts` (timestamp) from response as messageId
  // 6. Compose composite key: `${resolvedChannelId}:${ts}`
  // 7. Return { platform: "slack-bot", success, messageId: compositeKey }
}
```

**Key difference from webhook:** Bot API returns `ts` (message timestamp) which serves as Slack's unique message identifier for thread tracking. The `channelId` is included in the composite key for correct session registry lookup.

### 5. Session Registry Extension

**File:** `src/notifications/session-registry.ts`

```typescript
interface SessionMapping {
  platform: "discord-bot" | "telegram" | "slack-bot";  // Add slack-bot
  messageId: string;    // For Slack: "channelId:ts" composite key
  sessionId: string;
  tmuxPaneId: string;
  tmuxSessionName: string;
  event: NotificationEvent;
  createdAt: string;
  projectPath?: string;
}
```

**Slack message ID format:** `{channelId}:{ts}` (e.g., `C0123456789:1234567890.123456`)

This composite key is needed because Slack `ts` is unique only within a channel.

### 6. Slack Listener (Integrated into Reply Listener)

**File:** `src/notifications/reply-listener.ts` (MODIFIED)

**Design Decision:** The Slack Bolt App is integrated into the existing reply-listener process rather than running as a separate daemon. Rationale:

- **Single PID/state file**: No additional daemon management overhead
- **Shared resources**: Rate limiter, session registry, env allowlist reused automatically
- **Simpler ops**: One `startReplyListener()` / `stopReplyListener()` API manages everything
- **Co-existence**: Bolt's WebSocket runs on Node.js's event loop, coexisting with `setInterval`-based Discord/Telegram polling without blocking

**Trade-off accepted:** A Bolt crash could destabilize the poll loop. Mitigation: Bolt initialization is wrapped in try/catch; on failure, Slack is disabled but Discord/Telegram polling continues normally.

```typescript
// Inside the existing reply-listener daemon initialization:
let slackApp: App | null = null;

async function initSlackListener(config: SlackListenerConfig): Promise<void> {
  try {
    const app = new App({
      token: config.botToken,
      appToken: config.appToken,
      socketMode: true,
    });

    // Cache bot's own user ID for robust loop prevention
    const authResult = await app.client.auth.test({ token: config.botToken });
    const botUserId = authResult.user_id;

    // Handler 1: Thread replies to notification messages
    app.message(async ({ message, client }) => {
      // Filter non-text messages (subtype filtering)
      if (message.subtype) return;  // Skip system messages (channel_join, file_share, etc.)
      if (!message.thread_ts) return;  // Not a thread reply
      if (message.bot_id) return;       // Ignore bot messages
      if (message.user === botUserId) return;  // Robust self-loop prevention

      // Authorization check
      if (!config.authorizedUserIds.includes(message.user)) return;

      // Lookup session by thread parent timestamp
      const compositeId = `${message.channel}:${message.thread_ts}`;
      const mapping = await lookupByMessageId('slack-bot', compositeId);
      if (!mapping) return;  // Not a reply to our notification

      // Inject into Claude Code session
      const injected = await injectReply(
        mapping.tmuxPaneId,
        message.text,
        'slack',
        config.replyConfig
      );

      if (injected) {
        // Acknowledge with checkmark reaction (non-blocking, non-critical)
        client.reactions.add({
          channel: message.channel,
          timestamp: message.ts,
          name: 'white_check_mark',
        }).catch(() => {});  // Swallow reaction failures
      }
    });

    // Handler 2: Direct messages to bot (Phase 3)
    app.message(async ({ message, say }) => {
      if (message.subtype) return;
      if (message.channel_type !== 'im') return;
      if (message.bot_id) return;
      if (message.user === botUserId) return;

      // Authorization check
      if (!config.authorizedUserIds.includes(message.user)) return;

      // Find most recent active session for this user
      const session = await findActiveSession(message.user);
      if (!session) {
        await say('No active Claude Code session found.');
        return;
      }

      // Inject command
      const injected = await injectReply(
        session.tmuxPaneId,
        message.text,
        'slack',
        config.replyConfig
      );

      if (injected) {
        await say({
          text: ':white_check_mark: Sent to Claude Code session.',
          thread_ts: message.ts,
        });
      }
    });

    // Handler 3: @OMC mentions in channels (Phase 3)
    app.event('app_mention', async ({ event, say }) => {
      if (event.user === botUserId) return;
      if (!config.authorizedUserIds.includes(event.user)) return;

      // Strip the @mention prefix to get the command text
      const command = event.text.replace(/<@[A-Z0-9]+>\s*/, '').trim();
      if (!command) {
        await say({ text: 'What would you like me to do?', thread_ts: event.ts });
        return;
      }

      const session = await findActiveSession(event.user);
      if (!session) {
        await say({ text: 'No active Claude Code session found.', thread_ts: event.ts });
        return;
      }

      const injected = await injectReply(
        session.tmuxPaneId,
        command,
        'slack',
        config.replyConfig
      );

      if (injected) {
        await say({
          text: ':white_check_mark: Sent to Claude Code session.',
          thread_ts: event.ts,
        });
      }
    });

    await app.start();
    slackApp = app;
    log('Slack Socket Mode connected');
  } catch (err) {
    log(`Slack listener initialization failed: ${err.message}. Continuing without Slack.`);
    // Discord/Telegram polling continues unaffected
  }
}

// On SIGTERM, stop Bolt alongside existing cleanup:
async function shutdown(): Promise<void> {
  if (slackApp) {
    await slackApp.stop();
    slackApp = null;
  }
  // ... existing shutdown logic ...
}
```

### 7. `findActiveSession()` — User-to-Session Lookup

**File:** `src/notifications/session-registry.ts` (NEW FUNCTION)

The DM and @mention handlers (Phase 3) require looking up a user's most recent active session. This does not exist in the current registry, which maps `{platform, messageId}` to `{sessionId, tmuxPaneId}` with no user identity concept.

**Schema extension:** Add optional `userId` field to `SessionMapping`:

```typescript
interface SessionMapping {
  platform: "discord-bot" | "telegram" | "slack-bot";
  messageId: string;
  sessionId: string;
  tmuxPaneId: string;
  tmuxSessionName: string;
  event: NotificationEvent;
  createdAt: string;
  projectPath?: string;
  userId?: string;    // NEW: Platform user ID (for reverse lookup by user)
}
```

**Implementation:**

```typescript
/**
 * Find the most recent active session for a given user.
 * Searches all mappings with matching userId, verifies the tmux pane is alive,
 * and returns the most recent valid session.
 *
 * Used by DM and @mention handlers (Phase 3) to route messages
 * when there is no thread_ts to look up directly.
 *
 * @param userId - Platform user ID (e.g., Slack UXXXXXXXX)
 * @returns Most recent active SessionMapping, or null if none found
 */
export async function findActiveSession(userId: string): Promise<SessionMapping | null> {
  const allMappings = await loadAllMappings();

  // Filter by userId, sort by createdAt descending (most recent first)
  const userMappings = allMappings
    .filter(m => m.userId === userId)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  // Find the first mapping with a live tmux pane
  for (const mapping of userMappings) {
    const content = capturePaneContent(mapping.tmuxPaneId, 15);
    if (content) {
      const analysis = analyzePaneContent(content);
      if (analysis.confidence >= 0.4) {
        return mapping;
      }
    }
    // Pane is dead — clean up stale mapping
    await removeMessagesByPane(mapping.tmuxPaneId);
  }

  return null;
}
```

**Registration change:** When registering messages, include the userId:

```typescript
// In notify() / index.ts — pass userId when registering Slack messages
await registerMessage({
  platform: "slack-bot",
  messageId: compositeId,
  sessionId,
  tmuxPaneId,
  tmuxSessionName,
  event,
  createdAt: new Date().toISOString(),
  projectPath,
  userId: slackUserId,  // From config: authorizedSlackUserIds[0] or notification context
});
```

**Note:** For Phase 2 (thread replies only), `userId` is not required — lookup is by `compositeId`. The `findActiveSession()` function and `userId` field are **Phase 3 prerequisites** only.

### 8. Daemon Lifecycle (Integrated)

**File:** `src/notifications/reply-listener.ts`

Since the Slack listener is integrated into the existing reply-listener, no separate PID or state files are needed. The lifecycle is:

```
startReplyListener(config)  // Existing function, extended
  │
  ├─ Validate config (existing Discord/Telegram + new Slack)
  ├─ Check if already running (PID file: ~/.omc/state/reply-listener.pid)
  ├─ Fork detached child process
  │   ├─ [NEW] If Slack config present:
  │   │   ├─ initSlackListener(slackConfig)
  │   │   ├─ Bolt App connects via WebSocket
  │   │   └─ On failure: log warning, continue without Slack
  │   ├─ Enter existing pollLoop()
  │   │   ├─ pollDiscord()
  │   │   ├─ pollTelegram()
  │   │   └─ sleep(pollIntervalMs)
  │   └─ Graceful shutdown on SIGTERM (stops Bolt + poll loop)
  └─ Return PID

stopReplyListener()  // Existing function, unchanged
  │
  ├─ Read PID from ~/.omc/state/reply-listener.pid
  ├─ Send SIGTERM → triggers shutdown() which stops Bolt + poll loop
  ├─ Clean up PID file
  └─ Update state
```

**State file:** `~/.omc/state/reply-listener-state.json` (extended, not new)

```json
{
  "isRunning": true,
  "pid": 12345,
  "startedAt": "2026-02-28T09:00:00Z",
  "lastPollAt": "2026-02-28T09:15:30Z",
  "telegramLastUpdateId": 123456,
  "discordLastMessageId": "1234567890",
  "messagesInjected": 7,
  "errors": 0,
  "slackConnected": true,
  "slackConnectedSince": "2026-02-28T09:00:01Z",
  "slackEventsProcessed": 3
}
```

### 9. Security Model

| Layer | Mechanism | Details |
|-------|-----------|---------|
| **Transport** | TLS (Slack enforces HTTPS) | Socket Mode uses wss:// |
| **App Auth** | Signing secret verification | Bolt handles automatically |
| **User Auth** | Authorized user ID whitelist | `authorizedSlackUserIds` in config |
| **Input Sanitization** | `sanitizeReplyInput()` | Reuse existing (strip control chars, escape shell) |
| **Pane Verification** | `analyzePaneContent()` | Verify tmux pane is running Claude Code |
| **Rate Limiting** | Per-user rate limit | Reuse existing `rateLimitPerMinute` |
| **Token Storage** | Environment variables / .omc-config.json | File permissions 0600 |
| **Token Validation** | Format regex on startup | `xoxb-*` and `xapp-*` pattern validation |
| **Loop Prevention** | `bot_id` + `auth.test` self-ID check | Two-layer: skip `bot_id` messages AND compare `message.user` against bot's own user ID (obtained via `auth.test` on startup) |
| **Message Filtering** | `message.subtype` check | Skip system messages (channel_join, channel_leave, file_share, bot_message, etc.) — only process messages with no subtype |
| **Channel Scope** | Bot channel membership | Bot should only be invited to relevant channels to limit `message.channels` event volume |

### 10. Response Capture (Future Enhancement)

The initial version injects text into tmux and acknowledges with a checkmark. A future enhancement could capture Claude's response and post it back to Slack:

```
[Slack Message] → inject into tmux → Claude processes → capture output → post to Slack thread

Capture methods:
  1. tmux capture-pane (poll after injection, detect new ● lines)
  2. OMC hook integration (session-idle hook triggers Slack response)
  3. Dedicated output watcher (tail tmux pane, parse Claude output)
```

This is listed as Phase 2 because it requires significant complexity (output detection, streaming, formatting) and the initial version (inject-only with notification callbacks) is already useful.

---

## Implementation Phases

### Phase 1: Outbound via Bot API (Replace Webhook)

**Goal:** Send notifications via Bot API instead of webhook, capturing message `ts` for thread tracking.

**Files to modify:**
- `src/notifications/types.ts` - Add `"slack-bot"` to `NotificationPlatform` union
- `src/notifications/config.ts` - Add `SlackBotNotificationConfig`, token format validation
- `src/notifications/dispatcher.ts` - Add `sendSlackBot()`, add `slack-bot` branch to `dispatchNotifications()`
- `src/notifications/index.ts` - Extend message ID registration condition to include `"slack-bot"`

**New dependency:**
- `@slack/web-api` (lightweight, no Bolt needed for outbound-only)

**Deliverable:** Notifications appear in Slack with message IDs registered for reply tracking.

### Phase 2: Inbound via Socket Mode (Thread Replies)

**Goal:** Receive thread replies to notifications and inject them into Claude Code sessions.

**Files to modify:**
- `src/notifications/reply-listener.ts` - Integrate Bolt App initialization alongside existing poll loop; add thread reply handler with `message.subtype` filtering and bot self-ID check
- `src/notifications/session-registry.ts` - Add `"slack-bot"` to `SessionMapping.platform` union
- `src/notifications/config.ts` - Extend `getReplyConfig()` to recognize `slack-bot`; add `authorizedSlackUserIds` to `ReplyConfig`

**New dependency:**
- `@slack/bolt` (replaces Phase 1's `@slack/web-api`; Bolt includes `@slack/web-api` as transitive)

**Note:** `@slack/oauth` is a transitive dependency of Bolt but is **not used** — no OAuth redirect server is needed. The app uses manually-installed tokens.

**Deliverable:** Users can reply to notification threads, and their text is injected into the active Claude Code tmux session.

### Phase 3: DM & Mention Interface

**Goal:** Enable standalone commands via DM or @mention (not just replies to notifications).

**Prerequisites (must be implemented before Phase 3):**
- `findActiveSession()` function in `session-registry.ts`
- `userId` field added to `SessionMapping` schema
- `registerMessage()` calls updated to include `userId`

**Files to modify:**
- `src/notifications/session-registry.ts` - Add `userId` field, implement `findActiveSession()`
- `src/notifications/reply-listener.ts` - Add DM and @mention handlers to Bolt App

**Deliverable:** Users can DM the bot or @mention it to send text to their active Claude Code session.

### Phase 4: Response Capture & Streaming (Future)

**Goal:** Capture Claude's response and post it back to the Slack thread.

**Approach:** Monitor tmux pane output after injection, parse Claude's response, post to Slack thread.

**Deliverable:** Full conversation loop in Slack threads.

---

## Dependency Map

```
Phase 1:
  @slack/web-api (new, lightweight)
    └─ Used directly for chat.postMessage in sendSlackBot()

Phase 2+:
  @slack/bolt (replaces @slack/web-api)
    ├─ @slack/socket-mode  (WebSocket client)
    ├─ @slack/web-api      (HTTP API client, reused from Phase 1)
    └─ @slack/oauth        (transitive, NOT USED — no OAuth flow needed)

Existing (reused):
  ├─ session-registry.ts  → registerMessage(), lookupByMessageId(), loadAllMappings()
  ├─ reply-listener.ts    → injectReply(), sanitizeReplyInput(), pollLoop()
  ├─ dispatcher.ts        → markdownToSlackMrkdwn(), composeSlackText()
  └─ config.ts            → getNotificationConfig(), getReplyConfig()

Node.js version requirement: 18+ (ESM, import.meta.url, compatible with @slack/bolt v4)
```

---

## Testing Strategy

### Unit Tests

| Test | Description |
|------|-------------|
| `sendSlackBot()` payload | Mock fetch, verify `chat.postMessage` payload format and `ts` extraction |
| `SlackBotConfig` validation | Config parsing, env var resolution, token format validation (`xoxb-*`, `xapp-*`) |
| Session registry with slack-bot | Register/lookup with composite key format `{channelId}:{ts}` |
| Input sanitization (Slack-specific) | Slack mrkdwn characters (`*`, `~`, `>`), emoji shortcodes, user/channel mentions |
| Authorization filtering | Verify only authorized users can inject; empty whitelist rejects all |
| `findActiveSession()` | User-to-session reverse lookup, most-recent-first ordering, stale pane cleanup |
| Message subtype filtering | Verify system messages (channel_join, file_share, etc.) are skipped |
| Bot self-ID filtering | Verify messages from bot's own user ID are skipped (not just `bot_id` check) |

### Integration Tests

| Test | Description |
|------|-------------|
| Thread reply handler | Mock Bolt app, verify: event → registry lookup → pane verification → injection → reaction |
| DM handler | Mock Bolt app, verify: DM → `findActiveSession()` → injection → confirmation reply |
| @mention handler | Mock Bolt app, verify: mention text stripping → session lookup → injection |
| Concurrent registry access | Multiple readers/writers (poll loop + Slack events) accessing JSONL with `O_EXCL` locking |
| `getReplyConfig()` with Slack-only | Verify non-null return when only `slack-bot` is configured (no Discord/Telegram) |

### E2E Tests

| Test | Description |
|------|-------------|
| Full injection pipeline | Slack thread reply → session registry lookup → tmux pane verification → `sendToPane()` → reaction acknowledgment |
| Pruned message handling | Thread reply referencing a `ts` that has been pruned (24-hour TTL) → graceful "not found" |
| Bolt initialization failure | Slack config present but invalid token → Bolt fails → Discord/Telegram polling continues unaffected |

### Known Limitations (Not Tested)

| Scenario | Rationale |
|----------|-----------|
| Socket Mode reconnection | Bolt SDK handles internally; would require mocking WebSocket transport layer. Accepted as SDK responsibility. |
| Event loss during disconnect | Socket Mode does not replay missed events. This is a known, accepted limitation (see Risk Assessment). |

---

## Configuration Example

```json
// .omc-config.json
{
  "notifications": {
    "slack-bot": {
      "enabled": true,
      "botToken": "${OMC_SLACK_BOT_TOKEN}",
      "appToken": "${OMC_SLACK_APP_TOKEN}",
      "channelId": "C_DEFAULT_CHANNEL",
      "autoCreateChannels": true,
      "channelPrefix": "omc",
      "channelRouting": [
        { "pathPattern": "linkareer-main",  "channelId": "C_LINKAREER_MAIN" },
        { "pathPattern": "linkareer-admin", "channelId": "C_LINKAREER_ADMIN" }
      ],
      "mention": "<@U0123456789>"
    },
    "reply": {
      "enabled": true,
      "authorizedSlackUserIds": ["U0123456789"],
      "pollIntervalMs": 3000,
      "maxMessageLength": 500,
      "rateLimitPerMinute": 10,
      "includePrefix": true
    }
  }
}
```

**Channel resolution rules:**
1. `channelRouting` — explicit rules evaluated in order, **first match wins**
2. `autoCreateChannels` — if enabled, derives channel name from `projectPath` (e.g., `~/dev/my-app` → `#omc-my-app`), creates if missing
3. `channelId` — fallback default for unmatched projects or when `projectPath` is unavailable
- Bot must be invited to manually-configured channels; auto-created channels have the bot as creator (automatically joined)
- `channels:manage` scope required only when `autoCreateChannels: true`

**Or via environment variables:**

```bash
export OMC_SLACK_BOT_TOKEN="xoxb-..."
export OMC_SLACK_APP_TOKEN="xapp-..."
export OMC_SLACK_CHANNEL_ID="C_DEFAULT_CHANNEL"
export OMC_SLACK_AUTO_CREATE_CHANNELS=true
export OMC_SLACK_CHANNEL_PREFIX="omc"
export OMC_SLACK_CHANNEL_ROUTING='linkareer-main:C_MAIN,linkareer-admin:C_ADMIN'
export OMC_REPLY_ENABLED=true
export OMC_REPLY_SLACK_USER_IDS="U0123456789"
```

**Note:** `OMC_SLACK_CHANNEL_ROUTING` uses `pattern:channelId` pairs separated by commas. The `.omc-config.json` format is preferred for complex routing rules.

---

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| Slack rate limits (conversations.replies: 1/min) | Cannot use HTTP polling | Use Socket Mode (no rate limit on WebSocket events) |
| WebSocket disconnection | Missed messages during downtime | Bolt SDK auto-reconnects; add health monitoring |
| **Event loss during disconnect** | Replies sent while WebSocket is down are **not replayed** by Slack | **Accepted limitation.** Socket Mode does not guarantee delivery of events during disconnection. This differs from Telegram (`getUpdates` replays from offset) and Discord (message history is pollable). For interactive replies, this is acceptable — messages are time-sensitive and users can re-send. |
| **Zombie WebSocket connections** | NAT timeout or laptop sleep can create connections where client thinks it's connected but server has dropped it | Bolt handles via ping/pong timeouts. Configure `clientPingTimeout` option if default is insufficient. |
| Bot token compromise | Unauthorized access to Slack workspace | Env vars only, 0600 file perms, no hardcoding. **Token rotation:** regenerate in Slack dashboard, update env vars, restart daemon. |
| tmux injection security | Arbitrary command execution | Reuse sanitizeReplyInput() + authorized user whitelist |
| @slack/bolt bundle size | Larger dependency tree | Accept trade-off; Bolt is the official SDK. ~200KB overhead is irrelevant for a local daemon. |
| Bolt crash in integrated daemon | Could destabilize Discord/Telegram polling | Bolt initialization wrapped in try/catch; on failure, Slack is disabled but Discord/Telegram polling continues. |
| **High event volume** | Bot in many channels receives `message.channels` for every message | Bot should only be invited to relevant channels. `message.subtype` filter + `thread_ts` check discard irrelevant events early. |
| `chat.postMessage` rate limit | ~1 msg/sec/channel (Tier 2) | Unlikely to hit for OMC use case (5-10 notifications/hour). `reactions.add` is non-blocking and swallows failures. Add rate-limit header checking similar to existing Discord pattern. |

---

## References

- [Slack Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)
- [Slack Bolt for JavaScript](https://www.npmjs.com/package/@slack/bolt)
- [Slack API Rate Limits](https://docs.slack.dev/apis/web-api/rate-limits/)
- OMC reply-listener.ts (Discord/Telegram bidirectional reference)
- OMC session-registry.ts (JSONL message tracking)
