/**
 * Configuration loader - parses environment variables for omc-slack-mcp.
 */

export interface SlackMcpConfig {
  botToken: string;
  appToken?: string;
  defaultChannelId: string;
  authorizedUserIds: string[];
  mention?: string;
  registryPath: string;
  askTimeoutSeconds: number;
}

const DEFAULT_REGISTRY_PATH = `${process.env.HOME}/.omc/state/slack-session-registry.jsonl`;
const DEFAULT_ASK_TIMEOUT = 120;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function validateBotToken(token: string): void {
  if (!token.startsWith("xoxb-")) {
    throw new Error(`Invalid SLACK_BOT_TOKEN format: must start with "xoxb-" (got "${token.slice(0, 8)}...")`);
  }
}

function validateAppToken(token: string): void {
  if (!token.startsWith("xapp-")) {
    throw new Error(`Invalid SLACK_APP_TOKEN format: must start with "xapp-" (got "${token.slice(0, 8)}...")`);
  }
}

export function loadConfig(): SlackMcpConfig {
  const botToken = requireEnv("SLACK_BOT_TOKEN");
  validateBotToken(botToken);

  const defaultChannelId = requireEnv("SLACK_DEFAULT_CHANNEL_ID");

  const appToken = process.env.SLACK_APP_TOKEN;
  if (appToken) {
    validateAppToken(appToken);
  }

  const authorizedUserIds = (process.env.SLACK_AUTHORIZED_USER_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  const mention = process.env.SLACK_MENTION || undefined;

  const registryPath = process.env.SLACK_REGISTRY_PATH || DEFAULT_REGISTRY_PATH;

  const askTimeoutSeconds = process.env.SLACK_ASK_TIMEOUT
    ? parseInt(process.env.SLACK_ASK_TIMEOUT, 10)
    : DEFAULT_ASK_TIMEOUT;

  return {
    botToken,
    appToken,
    defaultChannelId,
    authorizedUserIds,
    mention,
    registryPath,
    askTimeoutSeconds,
  };
}
