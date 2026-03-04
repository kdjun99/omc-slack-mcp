/**
 * MCP tools for session registry: register_session, get_session
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { register, lookup, type SessionEntry } from "./registry.js";

export function registerSessionTools(server: McpServer): void {
  server.tool(
    "slack_register_session",
    "Register a Slack thread to tmux pane mapping. Used for inbound reply injection.",
    {
      channel_id: z.string().describe("Slack channel ID"),
      thread_ts: z.string().describe("Parent message timestamp (ts from slack_post_message)"),
      tmux_pane_id: z.string().describe('tmux pane ID (e.g. "%5")'),
      session_id: z.string().optional().describe("Claude session ID"),
      project_path: z.string().optional().describe("Project directory path"),
    },
    async ({ channel_id, thread_ts, tmux_pane_id, session_id, project_path }) => {
      const messageId = `${channel_id}:${thread_ts}`;

      const entry: SessionEntry = {
        messageId,
        channelId: channel_id,
        threadTs: thread_ts,
        tmuxPaneId: tmux_pane_id,
        sessionId: session_id,
        projectPath: project_path,
        createdAt: new Date().toISOString(),
      };

      register(entry);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: true, message_id: messageId }),
          },
        ],
      };
    },
  );

  server.tool(
    "slack_get_session",
    "Look up a session mapping by Slack thread. Returns tmux pane ID if registered.",
    {
      channel_id: z.string().describe("Slack channel ID"),
      thread_ts: z.string().describe("Parent message timestamp"),
    },
    async ({ channel_id, thread_ts }) => {
      const entry = lookup(channel_id, thread_ts);

      if (!entry) {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ found: false }) },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              found: true,
              tmux_pane_id: entry.tmuxPaneId,
              session_id: entry.sessionId,
              project_path: entry.projectPath,
              created_at: entry.createdAt,
            }),
          },
        ],
      };
    },
  );
}
