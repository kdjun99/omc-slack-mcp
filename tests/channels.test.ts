import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerChannelTools } from "../src/tools/channels.js";

vi.mock("../src/slack/client.js", () => {
  const mockClient = {
    conversations: {
      list: vi.fn(),
      history: vi.fn(),
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

describe("Channel Tools", () => {
  let server: McpServer;
  let toolHandlers: Map<string, (args: Record<string, unknown>) => Promise<unknown>>;
  const mockClient = getClient() as unknown as {
    conversations: {
      list: ReturnType<typeof vi.fn>;
      history: ReturnType<typeof vi.fn>;
      replies: ReturnType<typeof vi.fn>;
    };
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

    registerChannelTools(server);
  });

  describe("slack_list_channels", () => {
    it("lists channels", async () => {
      mockClient.conversations.list.mockResolvedValue({
        ok: true,
        channels: [
          { id: "C001", name: "general", is_member: true },
          { id: "C002", name: "random", is_member: false },
        ],
        response_metadata: { next_cursor: "" },
      });

      const handler = toolHandlers.get("slack_list_channels")!;
      const result = await handler({ limit: 10 }) as { content: Array<{ text: string }> };
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.channels).toHaveLength(2);
      expect(parsed.channels[0].id).toBe("C001");
      expect(parsed.channels[0].name).toBe("general");
    });

    it("caps limit at 200", async () => {
      mockClient.conversations.list.mockResolvedValue({
        ok: true,
        channels: [],
        response_metadata: {},
      });

      const handler = toolHandlers.get("slack_list_channels")!;
      await handler({ limit: 500 });

      expect(mockClient.conversations.list).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 200 }),
      );
    });

    it("returns error on API failure", async () => {
      mockClient.conversations.list.mockResolvedValue({
        ok: false,
        error: "missing_scope",
      });

      const handler = toolHandlers.get("slack_list_channels")!;
      const result = await handler({}) as { isError: boolean };
      expect(result.isError).toBe(true);
    });
  });

  describe("slack_get_channel_history", () => {
    it("returns messages", async () => {
      mockClient.conversations.history.mockResolvedValue({
        ok: true,
        messages: [
          { user: "U001", text: "Hello", ts: "1234567890.001" },
          { user: "U002", text: "World", ts: "1234567890.002", thread_ts: "1234567890.001" },
        ],
      });

      const handler = toolHandlers.get("slack_get_channel_history")!;
      const result = await handler({ channel_id: "C123", limit: 10 }) as { content: Array<{ text: string }> };
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.messages).toHaveLength(2);
      expect(parsed.messages[0].text).toBe("Hello");
      expect(parsed.messages[1].thread_ts).toBe("1234567890.001");
    });
  });

  describe("slack_get_thread_replies", () => {
    it("returns replies without parent message", async () => {
      mockClient.conversations.replies.mockResolvedValue({
        ok: true,
        messages: [
          { user: "U001", text: "Parent", ts: "1234567890.001" },
          { user: "U002", text: "Reply 1", ts: "1234567890.002" },
          { user: "U003", text: "Reply 2", ts: "1234567890.003" },
        ],
      });

      const handler = toolHandlers.get("slack_get_thread_replies")!;
      const result = await handler({
        channel_id: "C123",
        thread_ts: "1234567890.001",
      }) as { content: Array<{ text: string }> };
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.messages).toHaveLength(2);
      expect(parsed.messages[0].text).toBe("Reply 1");
      expect(parsed.messages[1].text).toBe("Reply 2");
    });
  });
});
