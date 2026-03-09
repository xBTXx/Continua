import { randomUUID } from "node:crypto";
import { ensureSchema, query } from "./db";

export type WebSessionStatus = "active" | "stale" | "closed" | "error";

export type WebSessionRecord = {
  id: string;
  conversationId: string | null;
  domain: string;
  crawl4aiSessionId: string;
  status: WebSessionStatus;
  lastSeenAt: string;
  expiresAt: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

type WebSessionRow = {
  id: string;
  conversation_id: string | null;
  domain: string;
  crawl4ai_session_id: string;
  status: string;
  last_seen_at: string;
  expires_at: string | null;
  meta: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

function normalizeConversationId(value: string | null | undefined) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function parseUrl(input: string) {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return new URL(trimmed);
  } catch {
    try {
      return new URL(`https://${trimmed}`);
    } catch {
      return null;
    }
  }
}

export function normalizeDomain(domainOrUrl: string) {
  const parsed = parseUrl(domainOrUrl);
  if (!parsed) {
    const value = domainOrUrl.trim().toLowerCase();
    if (!value) {
      return null;
    }
    return value.startsWith("www.") ? value.slice(4) : value;
  }
  const host = parsed.hostname.trim().toLowerCase();
  if (!host) {
    return null;
  }
  return host.startsWith("www.") ? host.slice(4) : host;
}

function readUrlFromToolArgs(
  name: string,
  args: Record<string, unknown>
): string | null {
  const directUrl = typeof args.url === "string" ? args.url.trim() : "";
  if (directUrl) {
    return directUrl;
  }
  if (name === "manage_session") {
    const initialUrl =
      typeof args.initial_url === "string" ? args.initial_url.trim() : "";
    if (initialUrl) {
      return initialUrl;
    }
  }
  return null;
}

function mapRow(row: WebSessionRow): WebSessionRecord {
  const status = row.status as WebSessionStatus;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    domain: row.domain,
    crawl4aiSessionId: row.crawl4ai_session_id,
    status,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    meta: row.meta ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function resolveDomainFromToolCall(
  name: string,
  args: Record<string, unknown>
) {
  const targetUrl = readUrlFromToolArgs(name, args);
  if (!targetUrl) {
    return null;
  }
  return normalizeDomain(targetUrl);
}

export async function getActiveWebSession({
  conversationId,
  domain,
}: {
  conversationId: string | null | undefined;
  domain: string | null | undefined;
}) {
  const conversationKey = normalizeConversationId(conversationId);
  const normalizedDomain = domain ? normalizeDomain(domain) : null;
  if (!conversationKey || !normalizedDomain) {
    return null;
  }

  await ensureSchema();
  const result = await query<WebSessionRow>(
    `
      SELECT
        id,
        conversation_id,
        domain,
        crawl4ai_session_id,
        status,
        last_seen_at,
        expires_at,
        meta,
        created_at,
        updated_at
      FROM web_sessions
      WHERE conversation_id = $1
        AND domain = $2
        AND status = 'active'
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    [conversationKey, normalizedDomain]
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export async function upsertWebSession({
  conversationId,
  domain,
  crawl4aiSessionId,
  status = "active",
  expiresAt = null,
  meta = null,
}: {
  conversationId: string | null | undefined;
  domain: string | null | undefined;
  crawl4aiSessionId: string | null | undefined;
  status?: WebSessionStatus;
  expiresAt?: string | null;
  meta?: Record<string, unknown> | null;
}) {
  const conversationKey = normalizeConversationId(conversationId);
  const normalizedDomain = domain ? normalizeDomain(domain) : null;
  const sessionId =
    typeof crawl4aiSessionId === "string" ? crawl4aiSessionId.trim() : "";

  if (!conversationKey || !normalizedDomain || !sessionId) {
    return null;
  }

  await ensureSchema();
  const result = await query<WebSessionRow>(
    `
      INSERT INTO web_sessions (
        id,
        conversation_id,
        domain,
        crawl4ai_session_id,
        status,
        last_seen_at,
        expires_at,
        meta
      )
      VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7)
      ON CONFLICT (conversation_id, domain)
      DO UPDATE SET
        crawl4ai_session_id = EXCLUDED.crawl4ai_session_id,
        status = EXCLUDED.status,
        last_seen_at = NOW(),
        expires_at = EXCLUDED.expires_at,
        meta = CASE
          WHEN EXCLUDED.meta IS NULL THEN web_sessions.meta
          WHEN web_sessions.meta IS NULL THEN EXCLUDED.meta
          ELSE web_sessions.meta || EXCLUDED.meta
        END,
        updated_at = NOW()
      RETURNING
        id,
        conversation_id,
        domain,
        crawl4ai_session_id,
        status,
        last_seen_at,
        expires_at,
        meta,
        created_at,
        updated_at
    `,
    [
      randomUUID(),
      conversationKey,
      normalizedDomain,
      sessionId,
      status,
      expiresAt,
      meta ? JSON.stringify(meta) : null,
    ]
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export async function markWebSessionStatus({
  crawl4aiSessionId,
  status,
  conversationId,
  domain,
}: {
  crawl4aiSessionId: string | null | undefined;
  status: WebSessionStatus;
  conversationId?: string | null | undefined;
  domain?: string | null | undefined;
}) {
  const sessionId =
    typeof crawl4aiSessionId === "string" ? crawl4aiSessionId.trim() : "";
  if (!sessionId) {
    return 0;
  }

  const conversationKey = normalizeConversationId(conversationId);
  const normalizedDomain = domain ? normalizeDomain(domain) : null;

  await ensureSchema();
  const result = await query(
    `
      UPDATE web_sessions
      SET status = $2,
          updated_at = NOW(),
          last_seen_at = NOW()
      WHERE crawl4ai_session_id = $1
        AND ($3::text IS NULL OR conversation_id = $3)
        AND ($4::text IS NULL OR domain = $4)
    `,
    [sessionId, status, conversationKey, normalizedDomain]
  );

  return result.rowCount ?? 0;
}

export async function getWebSessionContextBlock(
  conversationId: string | null | undefined,
  limit = 5
) {
  const conversationKey = normalizeConversationId(conversationId);
  if (!conversationKey) {
    return null;
  }

  await ensureSchema();
  const safeLimit = Math.min(10, Math.max(1, Math.floor(limit)));
  const result = await query<WebSessionRow>(
    `
      SELECT
        id,
        conversation_id,
        domain,
        crawl4ai_session_id,
        status,
        last_seen_at,
        expires_at,
        meta,
        created_at,
        updated_at
      FROM web_sessions
      WHERE conversation_id = $1
      ORDER BY last_seen_at DESC
      LIMIT $2
    `,
    [conversationKey, safeLimit]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const lines = result.rows.map((row) => {
    const stamp = new Date(row.last_seen_at).toISOString();
    return `- domain=${row.domain} session_id=${row.crawl4ai_session_id} status=${row.status} last_seen=${stamp}`;
  });

  return `Web session continuity hints:\n${lines.join("\n")}`;
}

export async function getWebSessionStats() {
  await ensureSchema();
  const result = await query<{
    total_count: string;
    active_count: string;
    stale_count: string;
    closed_count: string;
    error_count: string;
    latest_seen_at: string | null;
  }>(
    `
      SELECT
        COUNT(*)::text AS total_count,
        COUNT(*) FILTER (WHERE status = 'active')::text AS active_count,
        COUNT(*) FILTER (WHERE status = 'stale')::text AS stale_count,
        COUNT(*) FILTER (WHERE status = 'closed')::text AS closed_count,
        COUNT(*) FILTER (WHERE status = 'error')::text AS error_count,
        MAX(last_seen_at) AS latest_seen_at
      FROM web_sessions
    `
  );

  const row = result.rows[0];
  return {
    total: Number(row?.total_count ?? 0),
    active: Number(row?.active_count ?? 0),
    stale: Number(row?.stale_count ?? 0),
    closed: Number(row?.closed_count ?? 0),
    error: Number(row?.error_count ?? 0),
    latestSeenAt: row?.latest_seen_at ?? null,
  };
}

export async function listRecentWebSessions({
  conversationId,
  limit = 8,
}: {
  conversationId: string | null | undefined;
  limit?: number;
}) {
  const conversationKey = normalizeConversationId(conversationId);
  if (!conversationKey) {
    return [] as WebSessionRecord[];
  }

  const safeLimit = Math.min(20, Math.max(1, Math.floor(limit)));
  await ensureSchema();
  const result = await query<WebSessionRow>(
    `
      SELECT
        id,
        conversation_id,
        domain,
        crawl4ai_session_id,
        status,
        last_seen_at,
        expires_at,
        meta,
        created_at,
        updated_at
      FROM web_sessions
      WHERE conversation_id = $1
      ORDER BY last_seen_at DESC
      LIMIT $2
    `,
    [conversationKey, safeLimit]
  );

  return result.rows.map((row) => mapRow(row));
}
