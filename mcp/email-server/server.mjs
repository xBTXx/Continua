import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import * as imapSmtp from "./connectors/imapSmtp.mjs";
import * as outlookGraph from "./connectors/outlookGraph.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultConfigPath = path.join(__dirname, "config.json");
const configPath = process.env.MCP_EMAIL_CONFIG_PATH || defaultConfigPath;

function normalizeAccountId(accountId) {
  return accountId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function loadConfig() {
  if (!fs.existsSync(configPath)) {
    console.warn(
      `Config not found at ${configPath}. Create one from config.example.json.`
    );
    return { accounts: [], default_account_id: null };
  }

  const raw = fs.readFileSync(configPath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${configPath}: ${error.message}`);
  }

  if (!parsed.accounts || !Array.isArray(parsed.accounts)) {
    throw new Error(`Config at ${configPath} must include an accounts array.`);
  }

  return {
    accounts: parsed.accounts,
    default_account_id: parsed.default_account_id || null,
  };
}

const config = loadConfig();
const accountsById = new Map(
  config.accounts.map((account) => [account.id, account])
);

function resolveAccountId(accountId) {
  if (accountId) {
    return accountId;
  }
  if (config.default_account_id) {
    return config.default_account_id;
  }
  const firstAccount = config.accounts[0];
  return firstAccount ? firstAccount.id : null;
}

function getAccount(accountId) {
  const resolvedId = resolveAccountId(accountId);
  if (!resolvedId) {
    throw new Error("No accounts configured. Add accounts to config.json.");
  }

  const account = accountsById.get(resolvedId);
  if (!account) {
    throw new Error(`Unknown account id: ${resolvedId}`);
  }

  return account;
}

function envPrefix(accountId) {
  return `ACCOUNT_${normalizeAccountId(accountId)}`;
}

const connectorByType = {
  imap_smtp: imapSmtp,
  outlook_graph: outlookGraph,
};

function getConnector(account) {
  const connector = connectorByType[account.type];
  if (!connector) {
    throw new Error(`Unsupported account type: ${account.type}`);
  }
  return connector;
}

const tools = [
  {
    name: "list_accounts",
    description: "List configured email accounts for the MCP server.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "list_folders",
    description: "List folders/mailboxes for an account.",
    inputSchema: {
      type: "object",
      properties: {
        account_id: {
          type: "string",
          description: "Account id from config.json.",
        },
      },
    },
  },
  {
    name: "list_messages",
    description: "List messages for a folder with optional search query.",
    inputSchema: {
      type: "object",
      properties: {
        account_id: {
          type: "string",
          description: "Account id from config.json.",
        },
        folder: {
          type: "string",
          description: "Folder name. Defaults to INBOX.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Max messages to return (default 20).",
        },
        query: {
          type: "string",
          description:
            "Provider-specific search query or keywords (e.g., IMAP search or Graph filter).",
        },
      },
    },
  },
  {
    name: "get_message",
    description: "Fetch a single message by id.",
    inputSchema: {
      type: "object",
      properties: {
        account_id: {
          type: "string",
          description: "Account id from config.json.",
        },
        folder: {
          type: "string",
          description: "Folder name (IMAP only).",
        },
        message_id: {
          type: "string",
          description: "Provider message id.",
        },
      },
      required: ["message_id"],
    },
  },
  {
    name: "create_draft",
    description: "Create a draft message.",
    inputSchema: {
      type: "object",
      properties: {
        account_id: {
          type: "string",
          description: "Account id from config.json.",
        },
        to: {
          type: "array",
          items: { type: "string" },
          description: "Primary recipients.",
        },
        cc: {
          type: "array",
          items: { type: "string" },
        },
        bcc: {
          type: "array",
          items: { type: "string" },
        },
        subject: {
          type: "string",
        },
        body: {
          type: "string",
        },
        body_format: {
          type: "string",
          enum: ["text", "html"],
          description: "Message body format.",
        },
        reply_to_message_id: {
          type: "string",
          description: "Message id to reply to.",
        },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "send_message",
    description: "Send a message (optionally from a draft).",
    inputSchema: {
      type: "object",
      properties: {
        account_id: {
          type: "string",
          description: "Account id from config.json.",
        },
        draft_id: {
          type: "string",
          description: "Draft id to send.",
        },
        to: {
          type: "array",
          items: { type: "string" },
        },
        cc: {
          type: "array",
          items: { type: "string" },
        },
        bcc: {
          type: "array",
          items: { type: "string" },
        },
        subject: {
          type: "string",
        },
        body: {
          type: "string",
        },
        body_format: {
          type: "string",
          enum: ["text", "html"],
        },
      },
    },
  },
  {
    name: "reply",
    description: "Reply to a message by id.",
    inputSchema: {
      type: "object",
      properties: {
        account_id: {
          type: "string",
          description: "Account id from config.json.",
        },
        message_id: {
          type: "string",
        },
        body: {
          type: "string",
        },
        reply_all: {
          type: "boolean",
          description: "Include CC recipients.",
        },
      },
      required: ["message_id", "body"],
    },
  },
];

const server = new Server(
  {
    name: "assistant-email-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "list_accounts": {
        const data = config.accounts.map((account) => ({
          id: account.id,
          type: account.type,
          email: account.email,
          display_name: account.display_name || null,
          env_prefix: envPrefix(account.id),
        }));
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      }
      case "list_folders": {
        const account = getAccount(args?.account_id);
        const connector = getConnector(account);
        const data = await connector.listFolders({
          account,
          envPrefix: envPrefix(account.id),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      }
      case "list_messages": {
        const account = getAccount(args?.account_id);
        const connector = getConnector(account);
        const data = await connector.listMessages({
          account,
          envPrefix: envPrefix(account.id),
          folder: args?.folder || "INBOX",
          limit: args?.limit || 20,
          query: args?.query || null,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      }
      case "get_message": {
        const account = getAccount(args?.account_id);
        const connector = getConnector(account);
        const data = await connector.getMessage({
          account,
          envPrefix: envPrefix(account.id),
          folder: args?.folder || "INBOX",
          messageId: args?.message_id,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      }
      case "create_draft": {
        const account = getAccount(args?.account_id);
        const connector = getConnector(account);
        const data = await connector.createDraft({
          account,
          envPrefix: envPrefix(account.id),
          to: args?.to || [],
          cc: args?.cc || [],
          bcc: args?.bcc || [],
          subject: args?.subject || "",
          body: args?.body || "",
          bodyFormat: args?.body_format || "text",
          replyToMessageId: args?.reply_to_message_id || null,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      }
      case "send_message": {
        const account = getAccount(args?.account_id);
        const connector = getConnector(account);
        const data = await connector.sendMessage({
          account,
          envPrefix: envPrefix(account.id),
          draftId: args?.draft_id || null,
          to: args?.to || [],
          cc: args?.cc || [],
          bcc: args?.bcc || [],
          subject: args?.subject || "",
          body: args?.body || "",
          bodyFormat: args?.body_format || "text",
        });
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      }
      case "reply": {
        const account = getAccount(args?.account_id);
        const connector = getConnector(account);
        const data = await connector.reply({
          account,
          envPrefix: envPrefix(account.id),
          messageId: args?.message_id,
          body: args?.body || "",
          replyAll: Boolean(args?.reply_all),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: error.message }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
