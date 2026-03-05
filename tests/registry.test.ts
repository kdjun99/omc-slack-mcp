import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadRegistry, register, lookup, prune, size, clearRegistry, type SessionEntry } from "../src/session/registry.js";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("Session Registry", () => {
  let testDir: string;
  let testPath: string;

  beforeEach(() => {
    clearRegistry();
    testDir = join(tmpdir(), `omc-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    testPath = join(testDir, "registry.jsonl");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function makeEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
    return {
      messageId: "C123:1234567890.123456",
      channelId: "C123",
      threadTs: "1234567890.123456",
      tmuxPaneId: "%5",
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it("loads from empty state when file does not exist", () => {
    loadRegistry(testPath);
    expect(size()).toBe(0);
  });

  it("registers and looks up entries", () => {
    loadRegistry(testPath);
    const entry = makeEntry();
    register(entry);

    const found = lookup("C123", "1234567890.123456");
    expect(found).not.toBeNull();
    expect(found!.tmuxPaneId).toBe("%5");
  });

  it("returns null for unknown lookup", () => {
    loadRegistry(testPath);
    const found = lookup("C999", "0000000000.000000");
    expect(found).toBeNull();
  });

  it("persists entries to JSONL file", () => {
    loadRegistry(testPath);
    const entry = makeEntry();
    register(entry);

    const content = readFileSync(testPath, "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.messageId).toBe("C123:1234567890.123456");
  });

  it("loads existing entries from JSONL on startup", () => {
    const entry = makeEntry();
    writeFileSync(testPath, JSON.stringify(entry) + "\n");

    loadRegistry(testPath);
    const found = lookup("C123", "1234567890.123456");
    expect(found).not.toBeNull();
  });

  it("prunes entries older than TTL", () => {
    loadRegistry(testPath);

    const oldEntry = makeEntry({
      messageId: "C123:old",
      channelId: "C123",
      threadTs: "old",
      createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), // 48 hours ago
    });
    register(oldEntry);

    const newEntry = makeEntry({
      messageId: "C123:new",
      channelId: "C123",
      threadTs: "new",
      createdAt: new Date().toISOString(),
    });
    register(newEntry);

    const pruned = prune(24 * 60 * 60 * 1000);
    expect(pruned).toBe(1);
    expect(lookup("C123", "old")).toBeNull();
    expect(lookup("C123", "new")).not.toBeNull();
  });

  it("skips malformed JSONL lines", () => {
    writeFileSync(testPath, "not-valid-json\n" + JSON.stringify(makeEntry()) + "\n");
    loadRegistry(testPath);
    expect(size()).toBeGreaterThanOrEqual(1);
  });

  it("auto-prunes old entries on load", () => {
    const oldEntry = makeEntry({
      createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    });
    writeFileSync(testPath, JSON.stringify(oldEntry) + "\n");

    loadRegistry(testPath);
    expect(size()).toBe(0);
  });
});
