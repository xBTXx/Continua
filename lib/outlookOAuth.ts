import { createHmac, randomUUID } from "node:crypto";

const DEFAULT_SCOPES = [
  "offline_access",
  "Mail.Read",
  "Mail.ReadWrite",
  "Mail.Send",
  "User.Read",
];

export type OutlookTokenResponse = {
  token_type: string;
  scope: string;
  expires_in: number;
  ext_expires_in?: number;
  access_token: string;
  refresh_token?: string;
};

export function getOutlookConfig() {
  const clientId = process.env.OUTLOOK_CLIENT_ID;
  const clientSecret = process.env.OUTLOOK_CLIENT_SECRET;
  const tenantId = process.env.OUTLOOK_TENANT_ID || "common";
  const redirectUri = process.env.OUTLOOK_REDIRECT_URI;
  const scopes = (process.env.OUTLOOK_SCOPES || DEFAULT_SCOPES.join(" "))
    .split(" ")
    .map((scope) => scope.trim())
    .filter(Boolean);
  const stateSecret = process.env.OUTLOOK_STATE_SECRET;

  if (!clientId) {
    throw new Error("OUTLOOK_CLIENT_ID is required.");
  }
  if (!redirectUri) {
    throw new Error("OUTLOOK_REDIRECT_URI is required.");
  }
  if (!stateSecret) {
    throw new Error("OUTLOOK_STATE_SECRET is required.");
  }

  return {
    clientId,
    clientSecret: clientSecret || null,
    tenantId,
    redirectUri,
    scopes,
    stateSecret,
  };
}

export function buildOutlookAuthUrl(state: string) {
  const { clientId, tenantId, redirectUri, scopes } = getOutlookConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    response_mode: "query",
    scope: scopes.join(" "),
    state,
  });

  return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?${params.toString()}`;
}

export function createStateToken(accountId: string) {
  const { stateSecret } = getOutlookConfig();
  const payload = {
    accountId,
    nonce: randomUUID(),
    issuedAt: Date.now(),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", stateSecret)
    .update(encoded)
    .digest("base64url");
  return `${encoded}.${signature}`;
}

export function verifyStateToken(state: string) {
  const { stateSecret } = getOutlookConfig();
  const [encoded, signature] = state.split(".");
  if (!encoded || !signature) {
    return null;
  }
  const expected = createHmac("sha256", stateSecret)
    .update(encoded)
    .digest("base64url");
  if (expected !== signature) {
    return null;
  }

  const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
    accountId: string;
    issuedAt: number;
  };

  if (!parsed.accountId || !parsed.issuedAt) {
    return null;
  }

  const maxAgeMs = 10 * 60 * 1000;
  if (Date.now() - parsed.issuedAt > maxAgeMs) {
    return null;
  }

  return parsed;
}

export async function exchangeCodeForToken(code: string) {
  const { clientId, clientSecret, tenantId, redirectUri, scopes } =
    getOutlookConfig();

  if (!clientSecret) {
    throw new Error("OUTLOOK_CLIENT_SECRET is required to exchange tokens.");
  }

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
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
    throw new Error(`Outlook token exchange failed: ${text}`);
  }

  return (await response.json()) as OutlookTokenResponse;
}

export async function refreshOutlookToken(refreshToken: string) {
  const { clientId, clientSecret, tenantId, scopes } = getOutlookConfig();
  if (!clientSecret) {
    throw new Error("OUTLOOK_CLIENT_SECRET is required to refresh tokens.");
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

  return (await response.json()) as OutlookTokenResponse;
}
