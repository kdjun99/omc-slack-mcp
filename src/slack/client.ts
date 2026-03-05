/**
 * Slack WebClient singleton with auth validation.
 */

import { WebClient } from "@slack/web-api";

let client: WebClient | null = null;
let botUserId: string | null = null;

export async function initClient(botToken: string): Promise<string> {
  client = new WebClient(botToken);

  // Validate token and resolve bot user ID
  const authResult = await client.auth.test();
  if (!authResult.ok) {
    throw new Error(`Slack auth.test failed: ${authResult.error}`);
  }

  botUserId = authResult.user_id ?? null;
  console.error(`[omc-slack-mcp] Authenticated as bot user: ${botUserId}`);
  return botUserId ?? "";
}

export function getClient(): WebClient {
  if (!client) {
    throw new Error("Slack client not initialized. Call initClient() first.");
  }
  return client;
}

export function getBotUserId(): string | null {
  return botUserId;
}
