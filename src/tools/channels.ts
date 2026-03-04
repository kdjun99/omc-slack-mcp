/**
 * Slack channel/read tools: list_channels, get_history, get_thread_replies
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getClient } from "../slack/client.js";

export function registerChannelTools(server: McpServer): void {
  server.tool(
    "slack_list_channels",
    "List public channels in the Slack workspace.",
    {
      limit: z.number().optional().default(100).describe("Max channels to return (default: 100, max: 200)"),
      cursor: z.string().optional().describe("Pagination cursor for next page"),
    },
    async ({ limit, cursor }) => {
      const client = getClient();
      const result = await client.conversations.list({
        types: "public_channel",
        limit: Math.min(limit ?? 100, 200),
        cursor: cursor || undefined,
      });

      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: `Error: ${result.error}` }],
          isError: true,
        };
      }

      const channels = (result.channels ?? []).map((ch) => ({
        id: ch.id,
        name: ch.name,
        is_member: ch.is_member ?? false,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              channels,
              next_cursor: result.response_metadata?.next_cursor || undefined,
            }),
          },
        ],
      };
    },
  );

  server.tool(
    "slack_get_channel_history",
    "Get recent messages from a Slack channel.",
    {
      channel_id: z.string().describe("Slack channel ID"),
      limit: z.number().optional().default(10).describe("Number of messages to retrieve (default: 10)"),
    },
    async ({ channel_id, limit }) => {
      const client = getClient();
      const result = await client.conversations.history({
        channel: channel_id,
        limit: limit ?? 10,
      });

      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: `Error: ${result.error}` }],
          isError: true,
        };
      }

      const messages = (result.messages ?? []).map((msg) => ({
        user: msg.user,
        text: msg.text,
        ts: msg.ts,
        thread_ts: msg.thread_ts,
      }));

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ messages }) }],
      };
    },
  );

  server.tool(
    "slack_get_thread_replies",
    "Get all replies in a Slack message thread.",
    {
      channel_id: z.string().describe("Channel containing the thread"),
      thread_ts: z.string().describe("Parent message timestamp"),
      limit: z.number().optional().default(50).describe("Number of replies to retrieve (default: 50)"),
    },
    async ({ channel_id, thread_ts, limit }) => {
      const client = getClient();
      const result = await client.conversations.replies({
        channel: channel_id,
        ts: thread_ts,
        limit: limit ?? 50,
      });

      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: `Error: ${result.error}` }],
          isError: true,
        };
      }

      // First message is the parent; skip it to return only replies
      const messages = (result.messages ?? []).slice(1).map((msg) => ({
        user: msg.user,
        text: msg.text,
        ts: msg.ts,
      }));

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ messages }) }],
      };
    },
  );
}
