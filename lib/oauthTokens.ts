import { randomUUID } from "node:crypto";
import { ensureSchema, query } from "@/lib/db";

export type OAuthTokenRecord = {
  provider: string;
  accountId: string;
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: string | null;
  scope?: string | null;
  tokenType?: string | null;
};

export async function upsertOAuthToken(record: OAuthTokenRecord) {
  await ensureSchema();
  const id = randomUUID();

  await query(
    `
      INSERT INTO oauth_tokens (
        id,
        provider,
        account_id,
        access_token,
        refresh_token,
        expires_at,
        scope,
        token_type
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
      id,
      record.provider,
      record.accountId,
      record.accessToken,
      record.refreshToken ?? null,
      record.expiresAt ?? null,
      record.scope ?? null,
      record.tokenType ?? null,
    ]
  );
}

export async function getOAuthToken(
  provider: string,
  accountId: string
): Promise<OAuthTokenRecord | null> {
  await ensureSchema();
  const result = await query<{
    provider: string;
    account_id: string;
    access_token: string;
    refresh_token: string | null;
    expires_at: string | null;
    scope: string | null;
    token_type: string | null;
  }>(
    `
      SELECT provider, account_id, access_token, refresh_token, expires_at, scope, token_type
      FROM oauth_tokens
      WHERE provider = $1 AND account_id = $2
      LIMIT 1
    `,
    [provider, accountId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    provider: row.provider,
    accountId: row.account_id,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    expiresAt: row.expires_at,
    scope: row.scope,
    tokenType: row.token_type,
  };
}
