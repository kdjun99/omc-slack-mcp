import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMessagingTools } from "../src/tools/messaging.js";

// Mock the slack client module
vi.mock("../src/slack/client.js", () => {
  const mockClient = {
    chat: {
      postMessage: vi.fn(),
    },
    reactions: {
      add: vi.fn(),
    },
  };
  return {
    getClient: () => mockClient,
    getBotUserId: () => "B123",
    __mockClient: mockClient,
  };
});

import { getClient } from "../src/slack/client.js";

describe("Messaging Tools", () => {
  let server: McpServer;
  let toolHandlers: Map<string, (args: Record<string, unknown>) => Promise<unknown>>;
  const mockClient = getClient() as unknown as {
    chat: { postMessage: ReturnType<typeof vi.fn> };
    reactions: { add: ReturnType<typeof vi.fn> };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    server = new McpServer({ name: "test", version: "0.0.1" });
    toolHandlers = new Map();

    // Capture tool handlers from server.tool() calls
    const originalTool = server.tool.bind(server);
    server.tool = ((name: string, desc: string, schema: unknown, handler: unknown) => {
      toolHandlers.set(name, handler as (args: Record<string, unknown>) => Promise<unknown>);
      return originalTool(name, desc, schema, handler);
    }) as typeof server.tool;

    registerMessagingTools(server);
  });

  describe("slack_post_message", () => {
    it("posts a message and returns ts", async () => {
      mockClient.chat.postMessage.mockResolvedValue({
        ok: true,
        ts: "1234567890.123456",
        channel: "C123",
      });

      const handler = toolHandlers.get("slack_post_message")!;
      const result = await handler({ channel_id: "C123", text: "Hello" }) as { content: Array<{ text: string }> };

      expect(mockClient.chat.postMessage).toHaveBeenCalledWith({
        channel: "C123",
        text: "Hello",
        mrkdwn: true,
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.ok).toBe(true);
      expect(parsed.ts).toBe("1234567890.123456");
    });

    it("returns error when API fails", async () => {
      mockClient.chat.postMessage.mockResolvedValue({
        ok: false,
        error: "channel_not_found",
      });

      const handler = toolHandlers.get("slack_post_message")!;
      const result = await handler({ channel_id: "C999", text: "Hello" }) as { content: Array<{ text: string }>; isError: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("channel_not_found");
    });
  });

  describe("slack_reply_to_thread", () => {
    it("replies to a thread", async () => {
      mockClient.chat.postMessage.mockResolvedValue({
        ok: true,
        ts: "1234567890.999999",
      });

      const handler = toolHandlers.get("slack_reply_to_thread")!;
      const result = await handler({
        channel_id: "C123",
        thread_ts: "1234567890.123456",
        text: "Reply",
      }) as { content: Array<{ text: string }> };

      expect(mockClient.chat.postMessage).toHaveBeenCalledWith({
        channel: "C123",
        thread_ts: "1234567890.123456",
        text: "Reply",
        mrkdwn: true,
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.ok).toBe(true);
      expect(parsed.ts).toBe("1234567890.999999");
    });
  });

  describe("slack_add_reaction", () => {
    it("adds a reaction", async () => {
      mockClient.reactions.add.mockResolvedValue({ ok: true });

      const handler = toolHandlers.get("slack_add_reaction")!;
      const result = await handler({
        channel_id: "C123",
        timestamp: "1234567890.123456",
        reaction: "thumbsup",
      }) as { content: Array<{ text: string }> };

      expect(mockClient.reactions.add).toHaveBeenCalledWith({
        channel: "C123",
        timestamp: "1234567890.123456",
        name: "thumbsup",
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.ok).toBe(true);
    });

    it("returns error on failure", async () => {
      mockClient.reactions.add.mockResolvedValue({
        ok: false,
        error: "already_reacted",
      });

      const handler = toolHandlers.get("slack_add_reaction")!;
      const result = await handler({
        channel_id: "C123",
        timestamp: "1234567890.123456",
        reaction: "thumbsup",
      }) as { content: Array<{ text: string }>; isError: boolean };

      expect(result.isError).toBe(true);
    });
  });
});
