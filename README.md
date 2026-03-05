# omc-slack-mcp

Standalone MCP server for bidirectional Slack <-> Claude Code communication.

Claude Code can post messages, ask questions, read channels, and react to messages in Slack — all via MCP tools.

## Quick Start

### 1. Slack App Setup

Create a Slack App at [api.slack.com/apps](https://api.slack.com/apps) and configure:

**Bot Token Scopes** (OAuth & Permissions):
- `chat:write` — post messages
- `channels:read` — list channels
- `channels:history` — read channel history
- `groups:history` — read private channel history
- `reactions:write` — add emoji reactions
- `users:read` — resolve user info

**Event Subscriptions** (if using Phase 2):
- `message.channels`

**Socket Mode** (if using Phase 2):
- Enable Socket Mode
- Create an App-Level Token with `connections:write` scope

### 2. Environment Variables

Copy `.env-example` to `.env.local` and fill in your values:

```bash
cp .env-example .env.local
```

Required:
- `SLACK_BOT_TOKEN` — Bot User OAuth Token (`xoxb-*`)
- `SLACK_DEFAULT_CHANNEL_ID` — Default channel ID for notifications

Optional:
- `SLACK_APP_TOKEN` — App-Level Token for Socket Mode (`xapp-*`, Phase 2)
- `SLACK_AUTHORIZED_USER_IDS` — Comma-separated user IDs for reply authorization
- `SLACK_MENTION` — Default mention prefix (e.g. `<@U0DEVELOPER>`)
- `SLACK_ASK_TIMEOUT` — Timeout for `slack_ask` in seconds (default: 120)
- `SLACK_REGISTRY_PATH` — Custom session registry path

### 3. Install & Build

```bash
npm install
npm run build
```

### 4. Register with Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "omc-slack-mcp": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/path/to/omc-slack-mcp"
    }
  }
}
```

Or register globally in `~/.claude/.mcp.json` to use across all projects.

## Available Tools

### Messaging
| Tool | Description |
|------|-------------|
| `slack_post_message` | Post a message to a channel |
| `slack_reply_to_thread` | Reply to a message thread |
| `slack_add_reaction` | Add an emoji reaction |

### Channels
| Tool | Description |
|------|-------------|
| `slack_list_channels` | List public channels |
| `slack_get_channel_history` | Get recent messages from a channel |
| `slack_get_thread_replies` | Get replies in a thread |

### Interactive
| Tool | Description |
|------|-------------|
| `slack_ask` | Post a question and poll for a reply (blocking) |
| `slack_check_reply` | Non-blocking check for new replies |

### Session (for Phase 2 inbound injection)
| Tool | Description |
|------|-------------|
| `slack_register_session` | Map a Slack thread to a tmux pane |
| `slack_get_session` | Look up a session mapping |

## Development

```bash
npm run dev          # Run with tsx (hot reload)
npm test             # Run tests
npm run test:watch   # Run tests in watch mode
npm run lint         # Type-check
```

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design document.

## License

MIT
