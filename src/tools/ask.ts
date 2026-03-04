/**
 * Custom Slack tools: slack_ask (post + poll for reply), slack_check_reply
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getClient, getBotUserId } from "../slack/client.js";
import type { SlackMcpConfig } from "../config.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const POLL_INTERVAL_MS = 3_000;

export function registerAskTools(server: McpServer, config: SlackMcpConfig): void {
  server.tool(
    "slack_ask",
    "Post a question to Slack and wait for a human reply. Mentions the user and polls for a thread reply until timeout.",
    {
      channel_id: z.string().describe("Channel to post the question in"),
      question: z.string().describe("Question text to ask"),
      mention: z.string().optional().describe('User mention (e.g. "<@U123>"). Falls back to SLACK_MENTION env.'),
      timeout_seconds: z.number().optional().describe("Max wait time in seconds (default: 120)"),
    },
    async ({ channel_id, question, mention, timeout_seconds }) => {
      const client = getClient();
      const botUserId = getBotUserId();
      const effectiveMention = mention ?? config.mention;
      const timeoutMs = (timeout_seconds ?? config.askTimeoutSeconds) * 1000;

      // Post question with optional mention
      const messageText = effectiveMention
        ? `${effectiveMention}\n${question}`
        : question;

      const postResult = await client.chat.postMessage({
        channel: channel_id,
        text: messageText,
        mrkdwn: true,
      });

      if (!postResult.ok || !postResult.ts) {
        return {
          content: [
            { type: "text" as const, text: `Error posting question: ${postResult.error}` },
          ],
          isError: true,
        };
      }

      const threadTs = postResult.ts;
      const startTime = Date.now();

      // Poll for reply
      while (Date.now() - startTime < timeoutMs) {
        await sleep(POLL_INTERVAL_MS);

        const repliesResult = await client.conversations.replies({
          channel: channel_id,
          ts: threadTs,
          limit: 10,
        });

        if (!repliesResult.ok) continue;

        const replies = repliesResult.messages ?? [];

        // Skip first message (parent), find first human reply
        for (const reply of replies.slice(1)) {
          // Skip bot's own messages
          if (botUserId && reply.user === botUserId) continue;
          // Skip messages with subtype (bot_message, etc.)
          if ("subtype" in reply && (reply as Record<string, unknown>).subtype) continue;
          // Check authorized users (if configured)
          if (
            config.authorizedUserIds.length > 0 &&
            reply.user &&
            !config.authorizedUserIds.includes(reply.user)
          ) {
            continue;
          }

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  answered: true,
                  reply_text: reply.text,
                  user_id: reply.user,
                  reply_ts: reply.ts,
                  thread_ts: threadTs,
                }),
              },
            ],
          };
        }
      }

      // Timeout
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              answered: false,
              thread_ts: threadTs,
              timeout_seconds: timeout_seconds ?? config.askTimeoutSeconds,
            }),
          },
        ],
      };
    },
  );

  server.tool(
    "slack_check_reply",
    "Non-blocking check for new replies in a Slack thread. Use for manual polling.",
    {
      channel_id: z.string().describe("Channel containing the thread"),
      thread_ts: z.string().describe("Parent message timestamp"),
      after_ts: z.string().optional().describe("Only return replies after this timestamp"),
    },
    async ({ channel_id, thread_ts, after_ts }) => {
      const client = getClient();
      const botUserId = getBotUserId();

      const result = await client.conversations.replies({
        channel: channel_id,
        ts: thread_ts,
        limit: 50,
      });

      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: `Error: ${result.error}` }],
          isError: true,
        };
      }

      // Skip parent message, filter by after_ts, skip bot messages
      const replies = (result.messages ?? [])
        .slice(1)
        .filter((msg) => {
          if (after_ts && msg.ts && msg.ts <= after_ts) return false;
          if (botUserId && msg.user === botUserId) return false;
          if ("subtype" in msg && (msg as Record<string, unknown>).subtype) return false;
          return true;
        })
        .map((msg) => ({
          user_id: msg.user,
          text: msg.text,
          ts: msg.ts,
        }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              has_reply: replies.length > 0,
              replies,
            }),
          },
        ],
      };
    },
  );
}
