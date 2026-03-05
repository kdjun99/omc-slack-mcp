import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAskTools } from "../src/tools/ask.js";
import type { SlackMcpConfig } from "../src/config.js";

vi.mock("../src/slack/client.js", () => {
  const mockClient = {
    chat: {
      postMessage: vi.fn(),
    },
    conversations: {
      replies: vi.fn(),
    },
  };
  return {
    getClient: () => mockClient,
    getBotUserId: () => "B123",
    __mockClient: mockClient,
  };
});

import { getClient } from "../src/slack/client.js";

function makeConfig(overrides: Partial<SlackMcpConfig> = {}): SlackMcpConfig {
  return {
    botToken: "xoxb-test",
    defaultChannelId: "C123",
    authorizedUserIds: [],
    registryPath: "/tmp/test-registry.jsonl",
    askTimeoutSeconds: 2,
    ...overrides,
  };
}

describe("Ask Tools", () => {
  let server: McpServer;
  let toolHandlers: Map<string, (args: Record<string, unknown>) => Promise<unknown>>;
  const mockClient = getClient() as unknown as {
    chat: { postMessage: ReturnType<typeof vi.fn> };
    conversations: { replies: ReturnType<typeof vi.fn> };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    server = new McpServer({ name: "test", version: "0.0.1" });
    toolHandlers = new Map();

    const originalTool = server.tool.bind(server);
    server.tool = ((name: string, desc: string, schema: unknown, handler: unknown) => {
      toolHandlers.set(name, handler as (args: Record<string, unknown>) => Promise<unknown>);
      return originalTool(name, desc, schema, handler);
    }) as typeof server.tool;
  });

  describe("slack_ask", () => {
    it("posts question and returns reply when answered", async () => {
      const config = makeConfig();
      registerAskTools(server, config);

      mockClient.chat.postMessage.mockResolvedValue({
        ok: true,
        ts: "1234567890.001",
      });

      // First poll returns reply immediately
      mockClient.conversations.replies.mockResolvedValue({
        ok: true,
        messages: [
          { user: "B123", text: "Question", ts: "1234567890.001" },
          { user: "U001", text: "Answer!", ts: "1234567890.002" },
        ],
      });

      const handler = toolHandlers.get("slack_ask")!;
      const result = await handler({
        channel_id: "C123",
        question: "What do you think?",
        timeout_seconds: 10,
      }) as { content: Array<{ text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.answered).toBe(true);
      expect(parsed.reply_text).toBe("Answer!");
      expect(parsed.user_id).toBe("U001");
    });

    it("posts question with mention", async () => {
      const config = makeConfig({ mention: "<@U999>" });
      registerAskTools(server, config);

      mockClient.chat.postMessage.mockResolvedValue({
        ok: true,
        ts: "1234567890.001",
      });

      mockClient.conversations.replies.mockResolvedValue({
        ok: true,
        messages: [
          { user: "B123", text: "Question", ts: "1234567890.001" },
          { user: "U001", text: "Yes", ts: "1234567890.002" },
        ],
      });

      const handler = toolHandlers.get("slack_ask")!;
      await handler({
        channel_id: "C123",
        question: "Hello?",
        timeout_seconds: 10,
      });

      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("<@U999>"),
        }),
      );
    });

    it("skips bot's own messages", async () => {
      const config = makeConfig();
      registerAskTools(server, config);

      mockClient.chat.postMessage.mockResolvedValue({
        ok: true,
        ts: "1234567890.001",
      });

      mockClient.conversations.replies.mockResolvedValue({
        ok: true,
        messages: [
          { user: "B123", text: "Question", ts: "1234567890.001" },
          { user: "B123", text: "Bot reply", ts: "1234567890.002" },
          { user: "U001", text: "Human reply", ts: "1234567890.003" },
        ],
      });

      const handler = toolHandlers.get("slack_ask")!;
      const result = await handler({
        channel_id: "C123",
        question: "Test?",
        timeout_seconds: 10,
      }) as { content: Array<{ text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.reply_text).toBe("Human reply");
    });

    it("filters by authorized users", async () => {
      const config = makeConfig({ authorizedUserIds: ["U999"] });
      registerAskTools(server, config);

      mockClient.chat.postMessage.mockResolvedValue({
        ok: true,
        ts: "1234567890.001",
      });

      mockClient.conversations.replies.mockResolvedValue({
        ok: true,
        messages: [
          { user: "B123", text: "Question", ts: "1234567890.001" },
          { user: "U001", text: "Unauthorized", ts: "1234567890.002" },
          { user: "U999", text: "Authorized", ts: "1234567890.003" },
        ],
      });

      const handler = toolHandlers.get("slack_ask")!;
      const result = await handler({
        channel_id: "C123",
        question: "Test?",
        timeout_seconds: 10,
      }) as { content: Array<{ text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.reply_text).toBe("Authorized");
      expect(parsed.user_id).toBe("U999");
    });

    it("returns error when post fails", async () => {
      const config = makeConfig();
      registerAskTools(server, config);

      mockClient.chat.postMessage.mockResolvedValue({
        ok: false,
        error: "channel_not_found",
      });

      const handler = toolHandlers.get("slack_ask")!;
      const result = await handler({
        channel_id: "C999",
        question: "Test?",
      }) as { isError: boolean };

      expect(result.isError).toBe(true);
    });
  });

  describe("slack_check_reply", () => {
    it("returns replies", async () => {
      const config = makeConfig();
      registerAskTools(server, config);

      mockClient.conversations.replies.mockResolvedValue({
        ok: true,
        messages: [
          { user: "U001", text: "Parent", ts: "1234567890.001" },
          { user: "U002", text: "Reply", ts: "1234567890.002" },
        ],
      });

      const handler = toolHandlers.get("slack_check_reply")!;
      const result = await handler({
        channel_id: "C123",
        thread_ts: "1234567890.001",
      }) as { content: Array<{ text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.has_reply).toBe(true);
      expect(parsed.replies).toHaveLength(1);
      expect(parsed.replies[0].text).toBe("Reply");
    });

    it("filters replies by after_ts", async () => {
      const config = makeConfig();
      registerAskTools(server, config);

      mockClient.conversations.replies.mockResolvedValue({
        ok: true,
        messages: [
          { user: "U001", text: "Parent", ts: "1234567890.001" },
          { user: "U002", text: "Old reply", ts: "1234567890.002" },
          { user: "U003", text: "New reply", ts: "1234567890.004" },
        ],
      });

      const handler = toolHandlers.get("slack_check_reply")!;
      const result = await handler({
        channel_id: "C123",
        thread_ts: "1234567890.001",
        after_ts: "1234567890.003",
      }) as { content: Array<{ text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.replies).toHaveLength(1);
      expect(parsed.replies[0].text).toBe("New reply");
    });

    it("skips bot messages in check_reply", async () => {
      const config = makeConfig();
      registerAskTools(server, config);

      mockClient.conversations.replies.mockResolvedValue({
        ok: true,
        messages: [
          { user: "U001", text: "Parent", ts: "1234567890.001" },
          { user: "B123", text: "Bot reply", ts: "1234567890.002" },
        ],
      });

      const handler = toolHandlers.get("slack_check_reply")!;
      const result = await handler({
        channel_id: "C123",
        thread_ts: "1234567890.001",
      }) as { content: Array<{ text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.has_reply).toBe(false);
    });

    it("returns error on API failure", async () => {
      const config = makeConfig();
      registerAskTools(server, config);

      mockClient.conversations.replies.mockResolvedValue({
        ok: false,
        error: "thread_not_found",
      });

      const handler = toolHandlers.get("slack_check_reply")!;
      const result = await handler({
        channel_id: "C123",
        thread_ts: "1234567890.001",
      }) as { isError: boolean };

      expect(result.isError).toBe(true);
    });
  });
});
