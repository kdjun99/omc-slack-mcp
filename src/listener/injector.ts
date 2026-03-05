/**
 * tmux send-keys injection with input sanitization and rate limiting.
 */

import { execSync } from "child_process";

const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 10;
const MAX_MESSAGE_LENGTH = 4000;

const injectionTimestamps: number[] = [];

/**
 * Strip control characters (except newline) from input text.
 */
export function sanitizeInput(text: string): string {
  // Strip all control chars including newlines (prevent double-submit via tmux)
  let sanitized = text.replace(/[\x00-\x1f\x7f]/g, " ");

  // Truncate to max length
  if (sanitized.length > MAX_MESSAGE_LENGTH) {
    sanitized = sanitized.slice(0, MAX_MESSAGE_LENGTH);
  }

  return sanitized.trim();
}

/**
 * Escape text for safe use with tmux send-keys.
 * Wraps in single quotes with proper escaping.
 */
export function escapeForTmux(text: string): string {
  // Replace single quotes with '\'' (end quote, escaped quote, start quote)
  return "'" + text.replace(/'/g, "'\\''") + "'";
}

/**
 * Check if a tmux pane exists.
 */
export function verifyPane(paneId: string): boolean {
  // Validate pane ID format (e.g. "%5", "%12")
  if (!/^%\d+$/.test(paneId)) {
    return false;
  }

  try {
    execSync(`tmux has-session -t ${paneId} 2>/dev/null`, { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check rate limit. Returns true if injection is allowed.
 */
export function checkRateLimit(): boolean {
  const now = Date.now();

  // Remove timestamps outside the window
  while (injectionTimestamps.length > 0 && injectionTimestamps[0] < now - RATE_LIMIT_WINDOW_MS) {
    injectionTimestamps.shift();
  }

  if (injectionTimestamps.length >= RATE_LIMIT_MAX) {
    return false;
  }

  injectionTimestamps.push(now);
  return true;
}

/**
 * Reset rate limiter (for testing).
 */
export function resetRateLimiter(): void {
  injectionTimestamps.length = 0;
}

/**
 * Inject text into a tmux pane via send-keys.
 * Returns true on success, false on failure.
 */
export function injectReply(paneId: string, text: string): boolean {
  if (!checkRateLimit()) {
    console.error(`[omc-slack-mcp] Rate limit exceeded for pane ${paneId}`);
    return false;
  }

  const sanitized = sanitizeInput(text);
  if (!sanitized) {
    console.error("[omc-slack-mcp] Empty message after sanitization, skipping");
    return false;
  }

  if (!verifyPane(paneId)) {
    console.error(`[omc-slack-mcp] tmux pane ${paneId} does not exist`);
    return false;
  }

  const escaped = escapeForTmux(sanitized);

  try {
    execSync(`tmux send-keys -t ${paneId} ${escaped} Enter`, {
      timeout: 5000,
    });
    return true;
  } catch (error) {
    console.error(`[omc-slack-mcp] Failed to inject into pane ${paneId}:`, error);
    return false;
  }
}
