/**
 * Slack messaging tools: post_message, reply_to_thread, add_reaction
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getClient } from "../slack/client.js";

export function registerMessagingTools(server: McpServer): void {
  server.tool(
    "slack_post_message",
    "Post a new message to a Slack channel. Returns the message timestamp (ts) for threading.",
    {
      channel_id: z.string().describe("Slack channel ID (e.g. C07ABC123)"),
      text: z.string().describe("Message text (Slack mrkdwn supported)"),
    },
    async ({ channel_id, text }) => {
      const client = getClient();
      const result = await client.chat.postMessage({
        channel: channel_id,
        text,
        mrkdwn: true,
      });

      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: `Error: ${result.error}` }],
          isError: true,
        };
      }

      const response = {
        ok: true,
        ts: result.ts,
        channel: result.channel ?? channel_id,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(response) }],
      };
    },
  );

  server.tool(
    "slack_reply_to_thread",
    "Reply to an existing message thread in Slack.",
    {
      channel_id: z.string().describe("Channel containing the thread"),
      thread_ts: z.string().describe("Parent message timestamp"),
      text: z.string().describe("Reply text"),
    },
    async ({ channel_id, thread_ts, text }) => {
      const client = getClient();
      const result = await client.chat.postMessage({
        channel: channel_id,
        thread_ts,
        text,
        mrkdwn: true,
      });

      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: `Error: ${result.error}` }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: true, ts: result.ts }),
          },
        ],
      };
    },
  );

  server.tool(
    "slack_add_reaction",
    "Add an emoji reaction to a Slack message.",
    {
      channel_id: z.string().describe("Channel containing the message"),
      timestamp: z.string().describe("Message timestamp to react to"),
      reaction: z.string().describe('Emoji name without colons (e.g. "thumbsup")'),
    },
    async ({ channel_id, timestamp, reaction }) => {
      const client = getClient();
      const result = await client.reactions.add({
        channel: channel_id,
        timestamp,
        name: reaction,
      });

      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: `Error: ${result.error}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }],
      };
    },
  );
}
