/**
 * Socket Mode listener — receives Slack thread replies and injects them
 * into Claude Code tmux sessions via the session registry.
 */

import { App, LogLevel } from "@slack/bolt";
import type { SlackMcpConfig } from "../config.js";
import { lookup } from "../session/registry.js";
import { injectReply } from "./injector.js";

let app: App | null = null;

export interface SocketModeContext {
  botUserId: string;
  authorizedUserIds: string[];
}

/**
 * Initialize and start the Socket Mode listener.
 * Failures are isolated — MCP tools continue to work even if Socket Mode fails.
 */
export async function initSocketMode(
  config: SlackMcpConfig,
  botUserId: string,
): Promise<void> {
  if (!config.appToken) {
    console.error("[omc-slack-mcp] No SLACK_APP_TOKEN configured, Socket Mode disabled");
    return;
  }

  if (config.authorizedUserIds.length === 0) {
    console.error("[omc-slack-mcp] No SLACK_AUTHORIZED_USER_IDS configured, Socket Mode disabled");
    return;
  }

  try {
    app = new App({
      token: config.botToken,
      appToken: config.appToken,
      socketMode: true,
      // Force all Bolt logs to stderr so they don't corrupt MCP STDIO protocol
      logLevel: LogLevel.ERROR,
      logger: {
        debug: (...msgs) => console.error("[bolt:debug]", ...msgs),
        info: (...msgs) => console.error("[bolt:info]", ...msgs),
        warn: (...msgs) => console.error("[bolt:warn]", ...msgs),
        error: (...msgs) => console.error("[bolt:error]", ...msgs),
        getLevel: () => LogLevel.ERROR,
        setLevel: () => {},
        setName: () => {},
      },
    });

    const context: SocketModeContext = {
      botUserId,
      authorizedUserIds: config.authorizedUserIds,
    };

    registerMessageHandler(app, context);

    await app.start();
    console.error("[omc-slack-mcp] Socket Mode listener started");
  } catch (error) {
    console.error("[omc-slack-mcp] Socket Mode failed to start:", error);
    app = null;
    // Do not throw — MCP tools still work without Socket Mode
  }
}

/**
 * Register the message event handler with 4-layer filtering.
 */
export function registerMessageHandler(
  boltApp: App,
  context: SocketModeContext,
): void {
  boltApp.message(async ({ message, client }) => {
    try {
      // Layer 1: Plain messages only (skip bot_message, message_changed, etc.)
      if ("subtype" in message && message.subtype !== undefined) {
        return;
      }

      // Layer 2: Thread replies only (not top-level messages)
      if (
        !("thread_ts" in message) ||
        !message.thread_ts ||
        message.thread_ts === message.ts
      ) {
        return;
      }

      // Layer 3: Self-loop prevention (skip bot's own messages)
      if (!("user" in message) || !message.user || message.user === context.botUserId) {
        return;
      }

      // Layer 4: Authorization (only whitelisted users)
      if (!context.authorizedUserIds.includes(message.user)) {
        return;
      }

      // Extract text
      const text = "text" in message ? (message.text ?? "") : "";
      if (!text) {
        return;
      }

      // Lookup session registry for this thread
      const channelId = "channel" in message ? (message.channel as string) : "";
      const threadTs = message.thread_ts as string;
      const session = lookup(channelId, threadTs);

      if (!session) {
        // No session registered for this thread — ignore
        return;
      }

      // Inject reply into tmux pane
      const success = injectReply(session.tmuxPaneId, text);

      if (success) {
        // Add checkmark reaction as confirmation
        try {
          await client.reactions.add({
            channel: channelId,
            timestamp: message.ts as string,
            name: "white_check_mark",
          });
        } catch {
          // Reaction failure is non-critical
          console.error("[omc-slack-mcp] Failed to add confirmation reaction");
        }
      }
    } catch (error) {
      // Error isolation — never crash the process
      console.error("[omc-slack-mcp] Message handler error:", error);
    }
  });
}

/**
 * Check if Socket Mode is currently active.
 */
export function isSocketModeActive(): boolean {
  return app !== null;
}

/**
 * Stop the Socket Mode listener gracefully.
 */
export async function stopSocketMode(): Promise<void> {
  if (app) {
    try {
      await app.stop();
      console.error("[omc-slack-mcp] Socket Mode listener stopped");
    } catch (error) {
      console.error("[omc-slack-mcp] Error stopping Socket Mode:", error);
    }
    app = null;
  }
}
