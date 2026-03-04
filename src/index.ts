#!/usr/bin/env node

/**
 * omc-slack-mcp — MCP server for bidirectional Slack <-> Claude Code communication.
 *
 * Provides Slack tools that Claude can call directly, plus a background
 * Socket Mode listener for real-time inbound reply injection.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { initClient } from "./slack/client.js";
import { registerMessagingTools } from "./tools/messaging.js";
import { registerChannelTools } from "./tools/channels.js";
import { registerAskTools } from "./tools/ask.js";
import { registerSessionTools } from "./session/tools.js";
import { loadRegistry } from "./session/registry.js";

async function main(): Promise<void> {
  // Load configuration from environment variables
  const config = loadConfig();

  // Initialize Slack client and validate token
  await initClient(config.botToken);

  // Load session registry from disk
  loadRegistry(config.registryPath);

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

  // Connect via STDIO transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[omc-slack-mcp] Server started on STDIO transport");
}

main().catch((error) => {
  console.error("[omc-slack-mcp] Fatal error:", error);
  process.exit(1);
});
