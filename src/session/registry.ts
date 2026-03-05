/**
 * Session registry — maps Slack threads to tmux pane IDs.
 * In-memory Map with JSONL file persistence.
 */

import { readFileSync, appendFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

export interface SessionEntry {
  messageId: string;       // "{channelId}:{threadTs}" composite key
  channelId: string;
  threadTs: string;
  tmuxPaneId: string;
  sessionId?: string;
  projectPath?: string;
  createdAt: string;       // ISO 8601
}

const registry = new Map<string, SessionEntry>();
let registryPath: string | null = null;

function compositeKey(channelId: string, threadTs: string): string {
  return `${channelId}:${threadTs}`;
}

/**
 * Load existing registry from JSONL file into memory.
 * Auto-prunes entries older than 24 hours.
 */
export function loadRegistry(path: string): void {
  registryPath = path;

  // Ensure directory exists
  mkdirSync(dirname(path), { recursive: true });

  try {
    const content = readFileSync(path, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    const now = Date.now();
    const ttl = 24 * 60 * 60 * 1000; // 24 hours

    for (const line of lines) {
      try {
        const entry: SessionEntry = JSON.parse(line);
        const age = now - new Date(entry.createdAt).getTime();
        if (age < ttl) {
          registry.set(entry.messageId, entry);
        }
      } catch {
        // Skip malformed lines
      }
    }

    console.error(`[omc-slack-mcp] Registry loaded: ${registry.size} active entries`);
  } catch {
    // File doesn't exist yet — that's fine
    console.error("[omc-slack-mcp] Registry file not found, starting fresh");
  }
}

/**
 * Register a Slack thread → tmux pane mapping.
 */
export function register(entry: SessionEntry): void {
  registry.set(entry.messageId, entry);

  // Append to JSONL
  if (registryPath) {
    appendFileSync(registryPath, JSON.stringify(entry) + "\n");
  }
}

/**
 * Lookup session by channel + thread timestamp.
 */
export function lookup(channelId: string, threadTs: string): SessionEntry | null {
  return registry.get(compositeKey(channelId, threadTs)) ?? null;
}

/**
 * Remove entries older than TTL. Returns count of pruned entries.
 */
export function prune(ttlMs: number = 24 * 60 * 60 * 1000): number {
  const now = Date.now();
  let pruned = 0;

  for (const [key, entry] of registry) {
    const age = now - new Date(entry.createdAt).getTime();
    if (age >= ttlMs) {
      registry.delete(key);
      pruned++;
    }
  }

  // Rewrite JSONL without pruned entries
  if (pruned > 0 && registryPath) {
    const lines = Array.from(registry.values())
      .map((e) => JSON.stringify(e))
      .join("\n");
    writeFileSync(registryPath, lines ? lines + "\n" : "");
  }

  return pruned;
}

/**
 * Get registry size (for testing/debugging).
 */
export function size(): number {
  return registry.size;
}

/**
 * Clear all entries (for testing).
 */
export function clearRegistry(): void {
  registry.clear();
  registryPath = null;
}
