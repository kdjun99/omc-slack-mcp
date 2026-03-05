#!/usr/bin/env node

/**
 * omc-slack-mcp — MCP server for bidirectional Slack <-> Claude Code communication.
 *
 * Provides Slack tools that Claude can call directly, plus a background
 * Socket Mode listener for real-time inbound reply injection.
 */

import { config as dotenvConfig } from "dotenv";

// .env.local overrides .env (dotenv won't overwrite already-set vars)
// quiet: true suppresses stdout output that would corrupt MCP STDIO protocol
dotenvConfig({ path: ".env.local", quiet: true });
dotenvConfig({ path: ".env", quiet: true });

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { initClient } from "./slack/client.js";
import { registerMessagingTools } from "./tools/messaging.js";
import { registerChannelTools } from "./tools/channels.js";
import { registerAskTools } from "./tools/ask.js";
import { registerSessionTools } from "./session/tools.js";
import { loadRegistry } from "./session/registry.js";
import { initSocketMode, stopSocketMode, isSocketModeActive } from "./listener/socket-mode.js";

async function main(): Promise<void> {
  // Load configuration from environment variables
  const config = loadConfig();

  // Initialize Slack client and validate token
  const botUserId = await initClient(config.botToken);

  // Load session registry from disk
  loadRegistry(config.registryPath);

  // Start Socket Mode listener (non-blocking — MCP tools work even if this fails)
  await initSocketMode(config, botUserId);

  // Create MCP server
  const server = new McpServer({
    name: "omc-slack-mcp",
    version: "0.1.0",
  });

  // Register all tools
  registerMessagingTools(server);
  registerChannelTools(server);
  registerAskTools(server, config);
  registerSessionTools(server);

  // Diagnostic tool: check Socket Mode status
  server.tool(
    "slack_debug_status",
    "Check if Socket Mode listener is active in this MCP server process.",
    {},
    async () => {
      const status = {
        socket_mode_active: isSocketModeActive(),
        app_token_configured: !!config.appToken,
        authorized_users: config.authorizedUserIds,
        bot_user_id: botUserId,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }],
      };
    },
  );

  // Connect via STDIO transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[omc-slack-mcp] Server started on STDIO transport");

  // Graceful shutdown
  const shutdown = async () => {
    console.error("[omc-slack-mcp] Shutting down...");
    await stopSocketMode();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error) => {
  console.error("[omc-slack-mcp] Fatal error:", error);
  process.exit(1);
});
