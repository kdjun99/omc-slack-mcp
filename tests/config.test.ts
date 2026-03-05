import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    // Set required env vars
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    process.env.SLACK_DEFAULT_CHANNEL_ID = "C12345";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("parses required env vars", () => {
    const config = loadConfig();
    expect(config.botToken).toBe("xoxb-test-token");
    expect(config.defaultChannelId).toBe("C12345");
  });

  it("throws on missing SLACK_BOT_TOKEN", () => {
    delete process.env.SLACK_BOT_TOKEN;
    expect(() => loadConfig()).toThrow("Missing required environment variable: SLACK_BOT_TOKEN");
  });

  it("throws on missing SLACK_DEFAULT_CHANNEL_ID", () => {
    delete process.env.SLACK_DEFAULT_CHANNEL_ID;
    expect(() => loadConfig()).toThrow("Missing required environment variable: SLACK_DEFAULT_CHANNEL_ID");
  });

  it("throws on invalid bot token format", () => {
    process.env.SLACK_BOT_TOKEN = "invalid-token";
    expect(() => loadConfig()).toThrow('must start with "xoxb-"');
  });

  it("validates app token format when provided", () => {
    process.env.SLACK_APP_TOKEN = "invalid-app-token";
    expect(() => loadConfig()).toThrow('must start with "xapp-"');
  });

  it("accepts valid app token", () => {
    process.env.SLACK_APP_TOKEN = "xapp-test-app-token";
    const config = loadConfig();
    expect(config.appToken).toBe("xapp-test-app-token");
  });

  it("parses authorized user IDs", () => {
    process.env.SLACK_AUTHORIZED_USER_IDS = "U001, U002, U003";
    const config = loadConfig();
    expect(config.authorizedUserIds).toEqual(["U001", "U002", "U003"]);
  });

  it("returns empty array when no authorized user IDs", () => {
    const config = loadConfig();
    expect(config.authorizedUserIds).toEqual([]);
  });

  it("parses mention", () => {
    process.env.SLACK_MENTION = "<@U001>";
    const config = loadConfig();
    expect(config.mention).toBe("<@U001>");
  });

  it("uses default ask timeout", () => {
    const config = loadConfig();
    expect(config.askTimeoutSeconds).toBe(120);
  });

  it("parses custom ask timeout", () => {
    process.env.SLACK_ASK_TIMEOUT = "60";
    const config = loadConfig();
    expect(config.askTimeoutSeconds).toBe(60);
  });

  it("uses default registry path when not set", () => {
    const config = loadConfig();
    expect(config.registryPath).toContain("slack-session-registry.jsonl");
  });

  it("uses custom registry path", () => {
    process.env.SLACK_REGISTRY_PATH = "/custom/path/registry.jsonl";
    const config = loadConfig();
    expect(config.registryPath).toBe("/custom/path/registry.jsonl");
  });
});
