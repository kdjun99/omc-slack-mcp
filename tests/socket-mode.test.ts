import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @slack/bolt
const mockStart = vi.fn();
const mockStop = vi.fn();
const mockMessage = vi.fn();

vi.mock("@slack/bolt", () => ({
  App: vi.fn().mockImplementation(() => ({
    message: mockMessage,
    start: mockStart,
    stop: mockStop,
  })),
  LogLevel: { ERROR: "error", WARN: "warn", INFO: "info", DEBUG: "debug" },
}));

// Mock session registry
vi.mock("../src/session/registry.js", () => ({
  lookup: vi.fn(),
}));

// Mock injector
vi.mock("../src/listener/injector.js", () => ({
  injectReply: vi.fn(),
}));

import { App } from "@slack/bolt";
import { initSocketMode, registerMessageHandler, stopSocketMode } from "../src/listener/socket-mode.js";
import { lookup } from "../src/session/registry.js";
import { injectReply } from "../src/listener/injector.js";
import type { SlackMcpConfig } from "../src/config.js";

const mockLookup = lookup as unknown as ReturnType<typeof vi.fn>;
const mockInjectReply = injectReply as unknown as ReturnType<typeof vi.fn>;
const MockApp = App as unknown as ReturnType<typeof vi.fn>;

function makeConfig(overrides: Partial<SlackMcpConfig> = {}): SlackMcpConfig {
  return {
    botToken: "xoxb-test-token",
    appToken: "xapp-test-token",
    defaultChannelId: "C123",
    authorizedUserIds: ["U_HUMAN"],
    mention: undefined,
    registryPath: "/tmp/test-registry.jsonl",
    askTimeoutSeconds: 120,
    ...overrides,
  };
}

describe("Socket Mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStart.mockResolvedValue(undefined);
    mockStop.mockResolvedValue(undefined);
  });

  describe("initSocketMode", () => {
    it("starts Socket Mode with valid config", async () => {
      await initSocketMode(makeConfig(), "B_BOT");

      expect(MockApp).toHaveBeenCalledWith(
        expect.objectContaining({
          token: "xoxb-test-token",
          appToken: "xapp-test-token",
          socketMode: true,
        }),
      );
      expect(mockMessage).toHaveBeenCalledTimes(1);
      expect(mockStart).toHaveBeenCalledTimes(1);
    });

    it("skips when no appToken configured", async () => {
      await initSocketMode(makeConfig({ appToken: undefined }), "B_BOT");

      expect(MockApp).not.toHaveBeenCalled();
      expect(mockStart).not.toHaveBeenCalled();
    });

    it("skips when no authorized users configured", async () => {
      await initSocketMode(makeConfig({ authorizedUserIds: [] }), "B_BOT");

      expect(MockApp).not.toHaveBeenCalled();
      expect(mockStart).not.toHaveBeenCalled();
    });

    it("does not throw when start fails", async () => {
      mockStart.mockRejectedValue(new Error("connection failed"));

      await expect(initSocketMode(makeConfig(), "B_BOT")).resolves.not.toThrow();
    });
  });

  describe("stopSocketMode", () => {
    it("stops the app gracefully", async () => {
      await initSocketMode(makeConfig(), "B_BOT");
      await stopSocketMode();

      expect(mockStop).toHaveBeenCalledTimes(1);
    });
  });

  describe("Message Handler - 4 Layer Filtering", () => {
    let messageHandler: (args: { message: Record<string, unknown>; client: { reactions: { add: ReturnType<typeof vi.fn> } } }) => Promise<void>;
    const mockReactionsAdd = vi.fn().mockResolvedValue({ ok: true });
    const mockClient = { reactions: { add: mockReactionsAdd } };

    beforeEach(() => {
      vi.clearAllMocks();
      mockLookup.mockReturnValue(null);
      mockInjectReply.mockReturnValue(true);

      const boltApp = {
        message: (handler: typeof messageHandler) => {
          messageHandler = handler;
        },
        start: vi.fn(),
        stop: vi.fn(),
      };

      registerMessageHandler(boltApp as unknown as InstanceType<typeof App>, {
        botUserId: "B_BOT",
        authorizedUserIds: ["U_HUMAN"],
      });
    });

    it("Layer 1: ignores messages with subtype", async () => {
      await messageHandler({
        message: {
          subtype: "bot_message",
          thread_ts: "1234.5678",
          ts: "1234.9999",
          user: "U_HUMAN",
          text: "hello",
          channel: "C123",
        },
        client: mockClient,
      });

      expect(mockLookup).not.toHaveBeenCalled();
      expect(mockInjectReply).not.toHaveBeenCalled();
    });

    it("Layer 2: ignores top-level messages (no thread_ts)", async () => {
      await messageHandler({
        message: {
          ts: "1234.5678",
          user: "U_HUMAN",
          text: "hello",
          channel: "C123",
        },
        client: mockClient,
      });

      expect(mockLookup).not.toHaveBeenCalled();
    });

    it("Layer 2: ignores parent messages (thread_ts === ts)", async () => {
      await messageHandler({
        message: {
          thread_ts: "1234.5678",
          ts: "1234.5678",
          user: "U_HUMAN",
          text: "hello",
          channel: "C123",
        },
        client: mockClient,
      });

      expect(mockLookup).not.toHaveBeenCalled();
    });

    it("Layer 3: ignores bot's own messages (self-loop prevention)", async () => {
      await messageHandler({
        message: {
          thread_ts: "1234.5678",
          ts: "1234.9999",
          user: "B_BOT",
          text: "hello",
          channel: "C123",
        },
        client: mockClient,
      });

      expect(mockLookup).not.toHaveBeenCalled();
    });

    it("Layer 4: ignores unauthorized users", async () => {
      await messageHandler({
        message: {
          thread_ts: "1234.5678",
          ts: "1234.9999",
          user: "U_STRANGER",
          text: "hello",
          channel: "C123",
        },
        client: mockClient,
      });

      expect(mockLookup).not.toHaveBeenCalled();
    });

    it("ignores messages with no text", async () => {
      await messageHandler({
        message: {
          thread_ts: "1234.5678",
          ts: "1234.9999",
          user: "U_HUMAN",
          text: "",
          channel: "C123",
        },
        client: mockClient,
      });

      expect(mockInjectReply).not.toHaveBeenCalled();
    });

    it("ignores when no session registered for thread", async () => {
      mockLookup.mockReturnValue(null);

      await messageHandler({
        message: {
          thread_ts: "1234.5678",
          ts: "1234.9999",
          user: "U_HUMAN",
          text: "hello",
          channel: "C123",
        },
        client: mockClient,
      });

      expect(mockLookup).toHaveBeenCalledWith("C123", "1234.5678");
      expect(mockInjectReply).not.toHaveBeenCalled();
    });

    it("injects reply and adds reaction on success", async () => {
      mockLookup.mockReturnValue({
        messageId: "C123:1234.5678",
        channelId: "C123",
        threadTs: "1234.5678",
        tmuxPaneId: "%5",
        createdAt: new Date().toISOString(),
      });
      mockInjectReply.mockReturnValue(true);

      await messageHandler({
        message: {
          thread_ts: "1234.5678",
          ts: "1234.9999",
          user: "U_HUMAN",
          text: "deploy to staging",
          channel: "C123",
        },
        client: mockClient,
      });

      expect(mockInjectReply).toHaveBeenCalledWith("%5", "deploy to staging");
      expect(mockReactionsAdd).toHaveBeenCalledWith({
        channel: "C123",
        timestamp: "1234.9999",
        name: "white_check_mark",
      });
    });

    it("does not add reaction when injection fails", async () => {
      mockLookup.mockReturnValue({
        messageId: "C123:1234.5678",
        channelId: "C123",
        threadTs: "1234.5678",
        tmuxPaneId: "%5",
        createdAt: new Date().toISOString(),
      });
      mockInjectReply.mockReturnValue(false);

      await messageHandler({
        message: {
          thread_ts: "1234.5678",
          ts: "1234.9999",
          user: "U_HUMAN",
          text: "deploy to staging",
          channel: "C123",
        },
        client: mockClient,
      });

      expect(mockReactionsAdd).not.toHaveBeenCalled();
    });

    it("does not crash when reaction fails", async () => {
      mockLookup.mockReturnValue({
        messageId: "C123:1234.5678",
        channelId: "C123",
        threadTs: "1234.5678",
        tmuxPaneId: "%5",
        createdAt: new Date().toISOString(),
      });
      mockInjectReply.mockReturnValue(true);
      mockReactionsAdd.mockRejectedValue(new Error("already_reacted"));

      await expect(
        messageHandler({
          message: {
            thread_ts: "1234.5678",
            ts: "1234.9999",
            user: "U_HUMAN",
            text: "hello",
            channel: "C123",
          },
          client: mockClient,
        }),
      ).resolves.not.toThrow();
    });

    it("error isolation: handler does not throw on unexpected errors", async () => {
      mockLookup.mockImplementation(() => {
        throw new Error("unexpected");
      });

      await expect(
        messageHandler({
          message: {
            thread_ts: "1234.5678",
            ts: "1234.9999",
            user: "U_HUMAN",
            text: "hello",
            channel: "C123",
          },
          client: mockClient,
        }),
      ).resolves.not.toThrow();
    });
  });
});
