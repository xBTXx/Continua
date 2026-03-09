import { randomUUID } from "node:crypto";
import pg from "pg";

const PROVIDER = "outlook";
const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

const { Pool } = pg;

let pool = null;
let schemaReady = null;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString:
        process.env.DATABASE_URL ||
        process.env.POSTGRES_URL ||
        "postgres://app:change-me@db:5432/app",
    });
  }
  return pool;
}

async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      const client = getPool();
      await client.query(`
        CREATE TABLE IF NOT EXISTS oauth_tokens (
          id UUID PRIMARY KEY,
          provider TEXT NOT NULL,
          account_id TEXT NOT NULL,
          access_token TEXT NOT NULL,
          refresh_token TEXT,
          expires_at TIMESTAMPTZ,
          scope TEXT,
          token_type TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS oauth_tokens_provider_account_idx
          ON oauth_tokens(provider, account_id);
      `);
    })();
  }

  await schemaReady;
}

function getOAuthClientConfig() {
  const clientId = process.env.OUTLOOK_CLIENT_ID;
  const clientSecret = process.env.OUTLOOK_CLIENT_SECRET;
  const tenantId = process.env.OUTLOOK_TENANT_ID || "common";
  const scopes = (process.env.OUTLOOK_SCOPES ||
    "offline_access Mail.Read Mail.ReadWrite Mail.Send User.Read"
  )
    .split(" ")
    .map((scope) => scope.trim())
    .filter(Boolean);

  return {
    clientId,
    clientSecret,
    tenantId,
    scopes,
  };
}

async function getStoredToken(accountId) {
  await ensureSchema();
  const result = await getPool().query(
    `
      SELECT access_token, refresh_token, expires_at, scope, token_type
      FROM oauth_tokens
      WHERE provider = $1 AND account_id = $2
      LIMIT 1
    `,
    [PROVIDER, accountId]
  );

  return result.rows[0] || null;
}

async function updateStoredToken(accountId, tokenResponse, fallbackRefreshToken) {
  await ensureSchema();
  const expiresAt = tokenResponse.expires_in
    ? new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString()
    : null;
  const refreshToken = tokenResponse.refresh_token || fallbackRefreshToken || null;

  await getPool().query(
    `
      INSERT INTO oauth_tokens (
        id, provider, account_id, access_token, refresh_token, expires_at, scope, token_type
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (provider, account_id) DO UPDATE
        SET access_token = EXCLUDED.access_token,
            refresh_token = EXCLUDED.refresh_token,
            expires_at = EXCLUDED.expires_at,
            scope = EXCLUDED.scope,
            token_type = EXCLUDED.token_type,
            updated_at = NOW()
    `,
    [
      randomUUID(),
      PROVIDER,
      accountId,
      tokenResponse.access_token,
      refreshToken,
      expiresAt,
      tokenResponse.scope || null,
      tokenResponse.token_type || null,
    ]
  );
}

async function refreshAccessToken(refreshToken) {
  const { clientId, clientSecret, tenantId, scopes } = getOAuthClientConfig();
  if (!clientId || !clientSecret) {
    throw new Error(
      "Missing OUTLOOK_CLIENT_ID or OUTLOOK_CLIENT_SECRET for token refresh."
    );
  }

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: scopes.join(" "),
  });

  const response = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Outlook token refresh failed: ${text}`);
  }

  return response.json();
}

async function resolveAccessToken(accountId, envPrefix) {
  const tokenKey = `${envPrefix}_OAUTH_ACCESS_TOKEN`;
  const envToken = process.env[tokenKey];
  if (envToken) {
    return envToken;
  }

  const stored = await getStoredToken(accountId);
  if (!stored) {
    throw new Error(
      `No stored Outlook OAuth token for account ${accountId}. Connect Outlook in the UI or set ${tokenKey}.`
    );
  }

  const expiresAt = stored.expires_at ? Date.parse(stored.expires_at) : null;
  const isExpired = expiresAt ? Date.now() + 60_000 > expiresAt : false;

  if (!isExpired) {
    return stored.access_token;
  }

  if (!stored.refresh_token) {
    throw new Error("Outlook token expired and no refresh token is available.");
  }

  const refreshed = await refreshAccessToken(stored.refresh_token);
  await updateStoredToken(accountId, refreshed, stored.refresh_token);
  return refreshed.access_token;
}

async function graphRequest(token, path, options = {}) {
  const url = `${GRAPH_BASE_URL}/${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Graph request failed: ${text}`);
  }

  if (response.status === 204) {
    return null;
  }
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return null;
}

function mapRecipients(list = []) {
  return list.map((recipient) => ({
    name: recipient.emailAddress?.name || null,
    address: recipient.emailAddress?.address || null,
  }));
}

function mapGraphMessage(message) {
  return {
    id: message.id,
    subject: message.subject || "",
    from: mapRecipients(message.from ? [message.from] : []),
    to: mapRecipients(message.toRecipients || []),
    cc: mapRecipients(message.ccRecipients || []),
    receivedAt: message.receivedDateTime || null,
    preview: message.bodyPreview || null,
    isRead: message.isRead ?? null,
    messageId: message.internetMessageId || null,
  };
}

function normalizeGraphFolder(folder) {
  if (!folder) {
    return "inbox";
  }
  return folder;
}

export async function listFolders({ account, envPrefix }) {
  const token = await resolveAccessToken(account.id, envPrefix);
  const data = await graphRequest(token, "me/mailFolders?$top=200");
  return (data.value || []).map((folder) => ({
    id: folder.id,
    name: folder.displayName,
    totalCount: folder.totalItemCount,
    unreadCount: folder.unreadItemCount,
  }));
}

export async function listMessages({
  account,
  envPrefix,
  folder,
  limit,
  query,
}) {
  const token = await resolveAccessToken(account.id, envPrefix);
  const folderPath = normalizeGraphFolder(folder);
  const params = new URLSearchParams({
    $top: String(limit),
    $orderby: "receivedDateTime desc",
    $select:
      "id,subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,bodyPreview,internetMessageId",
  });

  if (query) {
    params.set("$search", `"${query}"`);
  }

  const data = await graphRequest(
    token,
    `me/mailFolders/${encodeURIComponent(folderPath)}/messages?${params.toString()}`,
    query ? { headers: { ConsistencyLevel: "eventual" } } : undefined
  );

  return (data.value || []).map((message) => ({
    ...mapGraphMessage(message),
    folder: folderPath,
  }));
}

export async function getMessage({ account, envPrefix, messageId }) {
  const token = await resolveAccessToken(account.id, envPrefix);
  const params = new URLSearchParams({
    $select:
      "id,subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,body,internetMessageId",
  });
  const data = await graphRequest(
    token,
    `me/messages/${encodeURIComponent(messageId)}?${params.toString()}`
  );

  return {
    ...mapGraphMessage(data),
    body: data.body?.content || "",
    bodyFormat: data.body?.contentType || "Text",
  };
}

export async function createDraft({
  account,
  envPrefix,
  to,
  cc,
  bcc,
  subject,
  body,
  bodyFormat,
  replyToMessageId,
}) {
  const token = await resolveAccessToken(account.id, envPrefix);
  const contentType = bodyFormat === "html" ? "HTML" : "Text";

  if (replyToMessageId) {
    const draft = await graphRequest(
      token,
      `me/messages/${encodeURIComponent(replyToMessageId)}/createReply`,
      { method: "POST" }
    );
    if (draft?.id) {
      await graphRequest(
        token,
        `me/messages/${encodeURIComponent(draft.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            body: { contentType, content: body },
          }),
        }
      );
      return { id: draft.id };
    }
  }

  const payload = {
    subject,
    body: {
      contentType,
      content: body,
    },
    toRecipients: to.map((address) => ({ emailAddress: { address } })),
    ccRecipients: cc.map((address) => ({ emailAddress: { address } })),
    bccRecipients: bcc.map((address) => ({ emailAddress: { address } })),
  };

  const data = await graphRequest(token, "me/messages", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  return { id: data.id };
}

export async function sendMessage({
  account,
  envPrefix,
  draftId,
  to,
  cc,
  bcc,
  subject,
  body,
  bodyFormat,
}) {
  const token = await resolveAccessToken(account.id, envPrefix);
  if (draftId) {
    await graphRequest(token, `me/messages/${encodeURIComponent(draftId)}/send`, {
      method: "POST",
    });
    return { id: draftId, sent: true };
  }

  const contentType = bodyFormat === "html" ? "HTML" : "Text";
  const payload = {
    message: {
      subject,
      body: {
        contentType,
        content: body,
      },
      toRecipients: to.map((address) => ({ emailAddress: { address } })),
      ccRecipients: cc.map((address) => ({ emailAddress: { address } })),
      bccRecipients: bcc.map((address) => ({ emailAddress: { address } })),
    },
    saveToSentItems: true,
  };

  await graphRequest(token, "me/sendMail", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  return { id: null, sent: true };
}

export async function reply({
  account,
  envPrefix,
  messageId,
  body,
  replyAll,
}) {
  const token = await resolveAccessToken(account.id, envPrefix);
  const endpoint = replyAll ? "replyAll" : "reply";
  const payload = { comment: body };

  await graphRequest(
    token,
    `me/messages/${encodeURIComponent(messageId)}/${endpoint}`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    }
  );

  return { id: messageId, sent: true };
}
