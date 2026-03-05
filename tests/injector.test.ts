import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  sanitizeInput,
  escapeForTmux,
  verifyPane,
  checkRateLimit,
  resetRateLimiter,
  injectReply,
} from "../src/listener/injector.js";

// Mock child_process
vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

import { execSync } from "child_process";

const mockExecSync = execSync as unknown as ReturnType<typeof vi.fn>;

describe("Injector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimiter();
  });

  describe("sanitizeInput", () => {
    it("replaces control characters with spaces", () => {
      expect(sanitizeInput("hello\x00world")).toBe("hello world");
      expect(sanitizeInput("hello\x07world")).toBe("hello world");
      expect(sanitizeInput("hello\x1bworld")).toBe("hello world");
      expect(sanitizeInput("hello\x7fworld")).toBe("hello world");
    });

    it("preserves normal text", () => {
      expect(sanitizeInput("hello world")).toBe("hello world");
      expect(sanitizeInput("Hello, World! 123")).toBe("Hello, World! 123");
    });

    it("preserves unicode characters", () => {
      expect(sanitizeInput("안녕하세요")).toBe("안녕하세요");
      expect(sanitizeInput("emoji 🎉")).toBe("emoji 🎉");
    });

    it("trims whitespace", () => {
      expect(sanitizeInput("  hello  ")).toBe("hello");
    });

    it("truncates long messages to 4000 chars", () => {
      const long = "a".repeat(5000);
      expect(sanitizeInput(long).length).toBe(4000);
    });

    it("returns empty string for control-only input", () => {
      expect(sanitizeInput("\x00\x01\x02")).toBe("");
    });

    it("replaces newlines with spaces to prevent double-submit", () => {
      expect(sanitizeInput("line1\nline2")).toBe("line1 line2");
      expect(sanitizeInput("a\r\nb")).toBe("a  b");
    });
  });

  describe("escapeForTmux", () => {
    it("wraps text in single quotes", () => {
      expect(escapeForTmux("hello")).toBe("'hello'");
    });

    it("escapes single quotes", () => {
      expect(escapeForTmux("it's")).toBe("'it'\\''s'");
    });

    it("handles text with special shell characters", () => {
      const result = escapeForTmux("hello $world `cmd` $(sub)");
      expect(result).toBe("'hello $world `cmd` $(sub)'");
    });

    it("handles empty string", () => {
      expect(escapeForTmux("")).toBe("''");
    });
  });

  describe("verifyPane", () => {
    it("returns true for valid pane", () => {
      mockExecSync.mockReturnValue(Buffer.from(""));
      expect(verifyPane("%5")).toBe(true);
    });

    it("returns false when pane does not exist", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("no session");
      });
      expect(verifyPane("%99")).toBe(false);
    });

    it("rejects invalid pane ID format", () => {
      expect(verifyPane("invalid")).toBe(false);
      expect(verifyPane("5")).toBe(false);
      expect(verifyPane("%")).toBe(false);
      expect(verifyPane("")).toBe(false);
      // No execSync call for invalid format
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it("accepts valid pane IDs", () => {
      mockExecSync.mockReturnValue(Buffer.from(""));
      expect(verifyPane("%0")).toBe(true);
      expect(verifyPane("%12")).toBe(true);
      expect(verifyPane("%999")).toBe(true);
    });
  });

  describe("checkRateLimit", () => {
    it("allows up to 10 injections per minute", () => {
      for (let i = 0; i < 10; i++) {
        expect(checkRateLimit()).toBe(true);
      }
      expect(checkRateLimit()).toBe(false);
    });

    it("resets after window expires", () => {
      vi.useFakeTimers();
      for (let i = 0; i < 10; i++) {
        checkRateLimit();
      }
      expect(checkRateLimit()).toBe(false);

      // Advance past the window
      vi.advanceTimersByTime(61_000);
      expect(checkRateLimit()).toBe(true);
      vi.useRealTimers();
    });
  });

  describe("injectReply", () => {
    it("injects sanitized text into tmux pane", () => {
      mockExecSync.mockReturnValue(Buffer.from(""));

      const result = injectReply("%5", "hello world");
      expect(result).toBe(true);

      // verifyPane call + send-keys call
      expect(mockExecSync).toHaveBeenCalledTimes(2);
      const sendKeysCall = mockExecSync.mock.calls[1][0];
      expect(sendKeysCall).toContain("tmux send-keys -t %5");
      expect(sendKeysCall).toContain("Enter");
    });

    it("returns false when pane does not exist", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("no session");
      });

      const result = injectReply("%99", "hello");
      expect(result).toBe(false);
    });

    it("returns false when rate limited", () => {
      mockExecSync.mockReturnValue(Buffer.from(""));

      for (let i = 0; i < 10; i++) {
        injectReply("%5", `msg ${i}`);
      }

      const result = injectReply("%5", "one more");
      expect(result).toBe(false);
    });

    it("returns false for empty text after sanitization", () => {
      const result = injectReply("%5", "\x00\x01");
      expect(result).toBe(false);
    });

    it("sanitizes control characters before injection", () => {
      mockExecSync.mockReturnValue(Buffer.from(""));

      injectReply("%5", "hello\x00\x07world");

      const sendKeysCall = mockExecSync.mock.calls[1][0];
      expect(sendKeysCall).toContain("hello  world");
    });
  });
});
