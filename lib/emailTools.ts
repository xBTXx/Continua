import fs from "node:fs";
import path from "node:path";
import { getOAuthToken } from "@/lib/oauthTokens";
import {
  findReplyTargetForDraft,
  getEmailReplyStatus,
  recordEmailReplyDraft,
  recordEmailReplySent,
} from "@/lib/emailReplyLog";
import * as imapSmtp from "@/mcp/email-server/connectors/imapSmtp.mjs";
import * as outlookGraph from "@/mcp/email-server/connectors/outlookGraph.mjs";

type EmailAccount = {
  id: string;
  type: "imap_smtp" | "outlook_graph";
  email: string;
  display_name?: string;
  imap?: {
    host: string;
    port: number;
    secure?: boolean;
    drafts_folder?: string;
    sent_folder?: string;
  };
  smtp?: {
    host: string;
    port: number;
    secure?: boolean;
  };
};

type EmailConfig = {
  default_account_id?: string;
  accounts: EmailAccount[];
};

type EmailToolArguments = Record<string, unknown>;

type EmailToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type EmailToolStatus = {
  id: string;
  label: string;
  status: "ok" | "error";
  details: string[];
};

export const EMAIL_TOOL_NAMES = [
  "list_accounts",
  "list_folders",
  "list_messages",
  "get_message",
  "create_draft",
  "send_message",
  "reply",
] as const;

const DEFAULT_CONFIG_PATH = path.join(
  process.cwd(),
  "mcp/email-server/config.json"
);

function normalizeAccountId(accountId: string) {
  return accountId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function envPrefix(accountId: string) {
  return `ACCOUNT_${normalizeAccountId(accountId)}`;
}

function resolveConfigPath() {
  return process.env.MCP_EMAIL_CONFIG_PATH || DEFAULT_CONFIG_PATH;
}

function loadConfig(): EmailConfig | null {
  const configPath = resolveConfigPath();
  if (!fs.existsSync(configPath)) {
    return null;
  }
  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw) as EmailConfig;
  if (!parsed.accounts || !Array.isArray(parsed.accounts)) {
    throw new Error(`Email config at ${configPath} must include accounts.`);
  }
  return parsed;
}


function resolveAccount(config: EmailConfig, accountId?: string) {
  const resolvedId =
    accountId || config.default_account_id || config.accounts[0]?.id;
  if (!resolvedId) {
    throw new Error("No email accounts configured.");
  }
  const account = config.accounts.find((entry) => entry.id === resolvedId);
  if (!account) {
    throw new Error(`Unknown account id: ${resolvedId}`);
  }
  return account;
}

function asStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function normalizeMessageId(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

async function attachReplyStatusToMessages(
  accountId: string,
  messages: Array<Record<string, unknown>>
) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return messages;
  }
  const ids = messages
    .map((entry) => normalizeMessageId(entry?.id))
    .filter((entry) => entry.length > 0);
  if (ids.length === 0) {
    return messages;
  }

  try {
    const statusMap = await getEmailReplyStatus(accountId, ids);
    if (statusMap.size === 0) {
      return messages;
    }
    return messages.map((entry) => {
      const id = normalizeMessageId(entry?.id);
      const status = id ? statusMap.get(id) : null;
      if (!status) {
        return entry;
      }
      return {
        ...entry,
        replyStatus: {
          replied: true,
          count: status.count,
          lastRepliedAt: status.lastRepliedAt,
        },
      };
    });
  } catch (error) {
    console.warn("Failed to load email reply status.", error);
    return messages;
  }
}

async function attachReplyStatusToMessage(
  accountId: string,
  message: Record<string, unknown>
) {
  const id = normalizeMessageId(message?.id);
  if (!id) {
    return message;
  }
  const withStatus = await attachReplyStatusToMessages(accountId, [message]);
  return withStatus[0] ?? message;
}

export function emailToolsEnabled() {
  if (process.env.MCP_EMAIL_ENABLED === "false") {
    return false;
  }
  return Boolean(loadConfig());
}

export function getEmailAccountHints() {
  const config = loadConfig();
  if (!config) {
    return [];
  }
  return config.accounts.map((account) => ({
    id: account.id,
    email: account.email,
    type: account.type,
    displayName: account.display_name || null,
  }));
}

function buildAccountLabel(account: EmailAccount) {
  const base =
    account.display_name ||
    account.email ||
    account.id ||
    "Unknown account";
  return `${base} Mailbox`;
}

function getMissingImapSmtpFields(account: EmailAccount) {
  const missing: string[] = [];
  if (!account.imap?.host) {
    missing.push("imap.host");
  }
  if (!account.imap?.port) {
    missing.push("imap.port");
  }
  if (!account.smtp?.host) {
    missing.push("smtp.host");
  }
  if (!account.smtp?.port) {
    missing.push("smtp.port");
  }
  return missing;
}

function getImapSmtpCredentialIssues(account: EmailAccount) {
  const missing: string[] = [];
  const prefix = envPrefix(account.id);
  if (!process.env[`${prefix}_USERNAME`]) {
    missing.push(`${prefix}_USERNAME`);
  }
  if (!process.env[`${prefix}_PASSWORD`]) {
    missing.push(`${prefix}_PASSWORD`);
  }
  return missing;
}

async function resolveOutlookToken(account: EmailAccount) {
  const prefix = envPrefix(account.id);
  const envToken = process.env[`${prefix}_OAUTH_ACCESS_TOKEN`];
  if (envToken) {
    return envToken;
  }
  const stored = await getOAuthToken("outlook", account.id);
  return stored?.accessToken || null;
}

function getOutlookEnvIssues() {
  const missing: string[] = [];
  if (!process.env.OUTLOOK_CLIENT_ID) {
    missing.push("OUTLOOK_CLIENT_ID");
  }
  if (!process.env.OUTLOOK_CLIENT_SECRET) {
    missing.push("OUTLOOK_CLIENT_SECRET");
  }
  if (!process.env.OUTLOOK_REDIRECT_URI) {
    missing.push("OUTLOOK_REDIRECT_URI");
  }
  if (!process.env.OUTLOOK_STATE_SECRET) {
    missing.push("OUTLOOK_STATE_SECRET");
  }
  return missing;
}

export async function getEmailToolStatus(): Promise<EmailToolStatus[]> {
  const config = loadConfig();
  if (!config) {
    return [
      {
        id: "email-tools",
        label: "Email tools",
        status: "error",
        details: ["Missing mcp/email-server/config.json"],
      },
    ];
  }

  if (process.env.MCP_EMAIL_ENABLED === "false") {
    return config.accounts.map((account) => ({
      id: account.id,
      label: buildAccountLabel(account),
      status: "error",
      details: ["MCP email tools disabled (MCP_EMAIL_ENABLED=false)."],
    }));
  }

  const statuses = await Promise.all(
    config.accounts.map(async (account) => {
      const details: string[] = [];

      if (account.type === "imap_smtp") {
        const missingFields = getMissingImapSmtpFields(account);
        if (missingFields.length > 0) {
          details.push(
            `Missing config fields: ${missingFields.join(", ")}.`
          );
        }

        const missingCreds = getImapSmtpCredentialIssues(account);
        if (missingCreds.length > 0) {
          details.push(
            `Missing env vars: ${missingCreds.join(", ")}.`
          );
        }
      } else if (account.type === "outlook_graph") {
        try {
          const token = await resolveOutlookToken(account);
          if (!token) {
            details.push("Outlook not connected (no OAuth token).");
            const oauthEnv = getOutlookEnvIssues();
            if (oauthEnv.length > 0) {
              details.push(
                `Missing OAuth env vars: ${oauthEnv.join(", ")}.`
              );
            }
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Outlook token check failed.";
          details.push(message);
        }
      }

      return {
        id: account.id,
        label: buildAccountLabel(account),
        status: details.length > 0 ? "error" : "ok",
        details,
      } satisfies EmailToolStatus;
    })
  );

  return statuses;
}

export function getEmailToolDefinitions(): EmailToolDefinition[] {
  if (!emailToolsEnabled()) {
    return [];
  }

  return [
    {
      type: "function",
      function: {
        name: "list_accounts",
        description: "List configured email accounts available to the assistant.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "list_folders",
        description: "List folders for an email account.",
        parameters: {
          type: "object",
          properties: {
            account_id: {
              type: "string",
              description: "Account id from config.json.",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_messages",
        description:
          "List messages for a folder with optional search query (IMAP supports simple keywords and after/before/on/since:YYYY-MM-DD).",
        parameters: {
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
              description: "Provider-specific search query or keywords.",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_message",
        description: "Fetch a single message by id.",
        parameters: {
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
    },
    {
      type: "function",
      function: {
        name: "create_draft",
        description: "Create a draft message (preferred before sending).",
        parameters: {
          type: "object",
          properties: {
            account_id: {
              type: "string",
              description: "Account id from config.json.",
            },
            to: { type: "array", items: { type: "string" } },
            cc: { type: "array", items: { type: "string" } },
            bcc: { type: "array", items: { type: "string" } },
            subject: { type: "string" },
            body: { type: "string" },
            body_format: { type: "string", enum: ["text", "html"] },
            reply_to_message_id: {
              type: "string",
              description: "Message id to reply to.",
            },
          },
          required: ["to", "subject", "body"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "send_message",
        description: "Send a message (optionally from a draft).",
        parameters: {
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
            to: { type: "array", items: { type: "string" } },
            cc: { type: "array", items: { type: "string" } },
            bcc: { type: "array", items: { type: "string" } },
            subject: { type: "string" },
            body: { type: "string" },
            body_format: { type: "string", enum: ["text", "html"] },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "reply",
        description: "Reply to a message by id.",
        parameters: {
          type: "object",
          properties: {
            account_id: {
              type: "string",
              description: "Account id from config.json.",
            },
            message_id: { type: "string" },
            body: { type: "string" },
            reply_all: { type: "boolean" },
          },
          required: ["message_id", "body"],
        },
      },
    },
  ];
}

export async function runEmailTool(
  name: string,
  args: EmailToolArguments,
  context?: { source?: string | null }
) {
  const config = loadConfig();
  if (!config) {
    throw new Error("Email tooling is not configured (missing config.json).");
  }

  const account = resolveAccount(config, args.account_id as string | undefined);
  const connector =
    account.type === "imap_smtp"
      ? imapSmtp
      : account.type === "outlook_graph"
        ? outlookGraph
        : null;

  if (!connector) {
    throw new Error(`Unsupported account type: ${account.type}`);
  }

  switch (name) {
    case "list_accounts":
      return config.accounts.map((entry) => ({
        id: entry.id,
        type: entry.type,
        email: entry.email,
        display_name: entry.display_name || null,
        env_prefix: envPrefix(entry.id),
      }));
    case "list_folders":
      return connector.listFolders({
        account,
        envPrefix: envPrefix(account.id),
      });
    case "list_messages": {
      const messages = await connector.listMessages({
        account,
        envPrefix: envPrefix(account.id),
        folder: (args.folder as string) || "INBOX",
        limit: Number.isFinite(args.limit as number) ? Number(args.limit) : 20,
        query: (args.query as string) || null,
      });
      return attachReplyStatusToMessages(account.id, messages);
    }
    case "get_message": {
      const message = await connector.getMessage({
        account,
        envPrefix: envPrefix(account.id),
        folder: (args.folder as string) || "INBOX",
        messageId: args.message_id as string,
      });
      return attachReplyStatusToMessage(account.id, message);
    }
    case "create_draft":
      {
        const draft = await connector.createDraft({
        account,
        envPrefix: envPrefix(account.id),
        to: asStringArray(args.to),
        cc: asStringArray(args.cc),
        bcc: asStringArray(args.bcc),
        subject: (args.subject as string) || "",
        body: (args.body as string) || "",
        bodyFormat: (args.body_format as string) || "text",
        replyToMessageId: (args.reply_to_message_id as string) || null,
      });
        const replyTo = normalizeMessageId(args.reply_to_message_id);
        const draftId = normalizeMessageId(draft?.id);
        if (replyTo && draftId) {
          void recordEmailReplyDraft({
            accountId: account.id,
            draftId,
            messageId: replyTo,
            source: context?.source ?? null,
          });
        }
        return draft;
      }
    case "send_message":
      {
        const result = await connector.sendMessage({
        account,
        envPrefix: envPrefix(account.id),
        draftId: (args.draft_id as string) || null,
        to: asStringArray(args.to),
        cc: asStringArray(args.cc),
        bcc: asStringArray(args.bcc),
        subject: (args.subject as string) || "",
        body: (args.body as string) || "",
        bodyFormat: (args.body_format as string) || "text",
      });
        const draftId = normalizeMessageId(args.draft_id);
        if (draftId && result && typeof result === "object" && result.sent) {
          const replyTarget = await findReplyTargetForDraft(
            account.id,
            draftId
          );
          if (replyTarget) {
            void recordEmailReplySent({
              accountId: account.id,
              messageId: replyTarget,
              draftId,
              source: context?.source ?? null,
            });
          }
        }
        return result;
      }
    case "reply":
      {
        const result = await connector.reply({
        account,
        envPrefix: envPrefix(account.id),
        messageId: args.message_id as string,
        body: (args.body as string) || "",
        replyAll: Boolean(args.reply_all),
      });
        const messageId = normalizeMessageId(args.message_id);
        if (messageId && result && typeof result === "object" && result.sent) {
          void recordEmailReplySent({
            accountId: account.id,
            messageId,
            source: context?.source ?? null,
          });
        }
        return result;
      }
    default:
      throw new Error(`Unknown email tool: ${name}`);
  }
}
