import { randomUUID } from "node:crypto";
import { ensureSchema, query } from "./db";
import { normalizeDomain } from "./webSessions";

type JsonRecord = Record<string, unknown>;

type WebArtifactRow = {
  id: string;
  conversation_id: string | null;
  domain: string;
  url: string;
  normalized_url: string;
  title: string | null;
  snippet: string | null;
  content_digest: string | null;
  source_tool: string;
  fetched_at: string;
  ttl_seconds: number | null;
  meta: JsonRecord | null;
  created_at: string;
};

type WebArtifactFreshRow = WebArtifactRow & {
  age_seconds: number;
  is_fresh: boolean;
};

export type WebArtifactRecord = {
  id: string;
  conversationId: string | null;
  domain: string;
  url: string;
  normalizedUrl: string;
  title: string | null;
  snippet: string | null;
  contentDigest: string | null;
  sourceTool: string;
  fetchedAt: string;
  ttlSeconds: number | null;
  meta: JsonRecord | null;
  createdAt: string;
};

export type WebArtifactFreshCandidate = WebArtifactRecord & {
  ageSeconds: number;
  isFresh: boolean;
};

function parseEnvNumber(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
) {
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

const WEB_ARTIFACT_TTL_SECONDS =
  parseEnvNumber(process.env.WEB_ARTIFACT_TTL_MINUTES, 30, 1, 24 * 60) * 60;
const WEB_ARTIFACT_MAX_DIGEST_CHARS = parseEnvNumber(
  process.env.WEB_ARTIFACT_MAX_DIGEST_CHARS,
  4000,
  400,
  20000
);
const WEB_ARTIFACT_MAX_SNIPPET_CHARS = parseEnvNumber(
  process.env.WEB_ARTIFACT_MAX_SNIPPET_CHARS,
  500,
  120,
  4000
);

function webArtifactsEnabled() {
  return process.env.WEB_ARTIFACT_ENABLED !== "false";
}

function normalizeConversationId(value: string | null | undefined) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonRecord;
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

function truncateText(value: string, maxLength: number) {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxLength - 3))}...`;
}

function coerceString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function mapRow(row: WebArtifactRow): WebArtifactRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    domain: row.domain,
    url: row.url,
    normalizedUrl: row.normalized_url,
    title: row.title,
    snippet: row.snippet,
    contentDigest: row.content_digest,
    sourceTool: row.source_tool,
    fetchedAt: row.fetched_at,
    ttlSeconds: row.ttl_seconds,
    meta: row.meta,
    createdAt: row.created_at,
  };
}

function mapFreshRow(row: WebArtifactFreshRow): WebArtifactFreshCandidate {
  return {
    ...mapRow(row),
    ageSeconds: Number.isFinite(Number(row.age_seconds))
      ? Math.max(0, Math.floor(Number(row.age_seconds)))
      : 0,
    isFresh: Boolean(row.is_fresh),
  };
}

export function normalizeWebUrl(url: string) {
  const parsed = parseUrl(url);
  if (!parsed) {
    return null;
  }

  parsed.hash = "";
  parsed.hostname = parsed.hostname.trim().toLowerCase();
  if (parsed.hostname.startsWith("www.")) {
    parsed.hostname = parsed.hostname.slice(4);
  }
  if (
    (parsed.protocol === "https:" && parsed.port === "443") ||
    (parsed.protocol === "http:" && parsed.port === "80")
  ) {
    parsed.port = "";
  }
  parsed.searchParams.sort();
  return parsed.toString();
}

function collectTextItemsFromToolResult(result: unknown): string[] {
  const texts: string[] = [];
  const record = asRecord(result);
  if (!record) {
    return texts;
  }

  for (const key of ["markdown", "text", "content_digest", "snippet"] as const) {
    const value = coerceString(record[key]);
    if (value) {
      texts.push(value);
    }
  }

  const content = Array.isArray(record.content) ? record.content : [];
  for (const item of content) {
    const itemRecord = asRecord(item);
    if (!itemRecord) {
      continue;
    }
    const text = coerceString(itemRecord.text);
    if (text) {
      texts.push(text);
    }
  }

  return texts;
}

function tryParseJson(text: string): JsonRecord | null {
  const normalized = text.trim();
  if (!normalized) {
    return null;
  }
  try {
    const parsed = JSON.parse(normalized) as unknown;
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function pickFirstString(record: JsonRecord | null | undefined, keys: string[]) {
  if (!record) {
    return null;
  }
  for (const key of keys) {
    const value = coerceString(record[key]);
    if (value) {
      return value;
    }
  }
  return null;
}

function shouldPersistArtifact(toolName: string) {
  const normalized = toolName.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (
    normalized === "crawl" ||
    normalized === "smart_crawl" ||
    normalized === "get_markdown" ||
    normalized === "extract_with_llm"
  ) {
    return true;
  }
  return (
    normalized.includes("crawl") ||
    normalized.includes("markdown") ||
    normalized.includes("extract")
  );
}

function buildArtifactCandidate({
  args,
  result,
}: {
  args: Record<string, unknown>;
  result: unknown;
}) {
  const rawTexts = collectTextItemsFromToolResult(result);
  const parsedJson = rawTexts
    .map((text) => tryParseJson(text))
    .find((value): value is JsonRecord => Boolean(value));
  const resultRecord = asRecord(result);

  const url =
    coerceString(args.url) ||
    pickFirstString(parsedJson, ["url", "page_url", "source_url", "final_url"]) ||
    pickFirstString(resultRecord, ["url", "page_url", "source_url", "final_url"]);

  const title =
    pickFirstString(parsedJson, ["title", "page_title"]) ||
    pickFirstString(resultRecord, ["title", "page_title"]);

  const snippet =
    pickFirstString(parsedJson, ["snippet", "summary", "description"]) ||
    pickFirstString(resultRecord, ["snippet", "summary", "description"]);

  const digestFromJson = pickFirstString(parsedJson, [
    "markdown",
    "content",
    "content_digest",
    "text",
    "body",
    "excerpt",
  ]);

  const digestFromResult = pickFirstString(resultRecord, [
    "markdown",
    "content",
    "content_digest",
    "text",
    "body",
    "excerpt",
  ]);

  const fallbackDigest = rawTexts[0] ? truncateText(rawTexts[0], WEB_ARTIFACT_MAX_DIGEST_CHARS) : null;

  const contentDigest = truncateText(
    digestFromJson || digestFromResult || fallbackDigest || "",
    WEB_ARTIFACT_MAX_DIGEST_CHARS
  );

  return {
    url,
    title: title ? truncateText(title, 240) : null,
    snippet: snippet ? truncateText(snippet, WEB_ARTIFACT_MAX_SNIPPET_CHARS) : null,
    contentDigest: contentDigest || null,
  };
}

export async function upsertWebArtifact({
  conversationId,
  domain,
  url,
  title,
  snippet,
  contentDigest,
  sourceTool,
  ttlSeconds = WEB_ARTIFACT_TTL_SECONDS,
  meta,
}: {
  conversationId: string | null | undefined;
  domain?: string | null;
  url: string;
  title?: string | null;
  snippet?: string | null;
  contentDigest?: string | null;
  sourceTool: string;
  ttlSeconds?: number | null;
  meta?: JsonRecord | null;
}) {
  if (!webArtifactsEnabled()) {
    return null;
  }

  const conversationKey = normalizeConversationId(conversationId);
  const normalizedUrl = normalizeWebUrl(url);
  const normalizedDomain =
    (domain ? normalizeDomain(domain) : null) || normalizeDomain(url);
  const toolName = sourceTool.trim();

  if (!normalizedUrl || !normalizedDomain || !toolName) {
    return null;
  }

  const safeTtl =
    typeof ttlSeconds === "number" && Number.isFinite(ttlSeconds)
      ? Math.max(60, Math.floor(ttlSeconds))
      : WEB_ARTIFACT_TTL_SECONDS;

  await ensureSchema();

  if (!conversationKey) {
    const inserted = await query<WebArtifactRow>(
      `
        INSERT INTO web_artifacts (
          id,
          conversation_id,
          domain,
          url,
          normalized_url,
          title,
          snippet,
          content_digest,
          source_tool,
          fetched_at,
          ttl_seconds,
          meta
        )
        VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, NOW(), $9, $10)
        RETURNING
          id,
          conversation_id,
          domain,
          url,
          normalized_url,
          title,
          snippet,
          content_digest,
          source_tool,
          fetched_at,
          ttl_seconds,
          meta,
          created_at
      `,
      [
        randomUUID(),
        normalizedDomain,
        url,
        normalizedUrl,
        title ? truncateText(title, 240) : null,
        snippet ? truncateText(snippet, WEB_ARTIFACT_MAX_SNIPPET_CHARS) : null,
        contentDigest
          ? truncateText(contentDigest, WEB_ARTIFACT_MAX_DIGEST_CHARS)
          : null,
        toolName,
        safeTtl,
        meta ? JSON.stringify(meta) : null,
      ]
    );

    return inserted.rows[0] ? mapRow(inserted.rows[0]) : null;
  }

  const result = await query<WebArtifactRow>(
    `
      INSERT INTO web_artifacts (
        id,
        conversation_id,
        domain,
        url,
        normalized_url,
        title,
        snippet,
        content_digest,
        source_tool,
        fetched_at,
        ttl_seconds,
        meta
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10, $11)
      ON CONFLICT (conversation_id, normalized_url)
      DO UPDATE SET
        domain = EXCLUDED.domain,
        url = EXCLUDED.url,
        title = COALESCE(EXCLUDED.title, web_artifacts.title),
        snippet = COALESCE(EXCLUDED.snippet, web_artifacts.snippet),
        content_digest = COALESCE(EXCLUDED.content_digest, web_artifacts.content_digest),
        source_tool = EXCLUDED.source_tool,
        fetched_at = NOW(),
        ttl_seconds = EXCLUDED.ttl_seconds,
        meta = CASE
          WHEN EXCLUDED.meta IS NULL THEN web_artifacts.meta
          WHEN web_artifacts.meta IS NULL THEN EXCLUDED.meta
          ELSE web_artifacts.meta || EXCLUDED.meta
        END
      RETURNING
        id,
        conversation_id,
        domain,
        url,
        normalized_url,
        title,
        snippet,
        content_digest,
        source_tool,
        fetched_at,
        ttl_seconds,
        meta,
        created_at
    `,
    [
      randomUUID(),
      conversationKey,
      normalizedDomain,
      url,
      normalizedUrl,
      title ? truncateText(title, 240) : null,
      snippet ? truncateText(snippet, WEB_ARTIFACT_MAX_SNIPPET_CHARS) : null,
      contentDigest ? truncateText(contentDigest, WEB_ARTIFACT_MAX_DIGEST_CHARS) : null,
      toolName,
      safeTtl,
      meta ? JSON.stringify(meta) : null,
    ]
  );

  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function saveWebArtifactFromToolResult({
  conversationId,
  domain,
  name,
  args,
  result,
  source,
  sessionId,
}: {
  conversationId: string | null | undefined;
  domain: string | null;
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  source: "chat" | "idle";
  sessionId?: string | null;
}) {
  if (!webArtifactsEnabled() || !shouldPersistArtifact(name)) {
    return null;
  }

  const candidate = buildArtifactCandidate({ args, result });
  if (!candidate.url) {
    return null;
  }

  return upsertWebArtifact({
    conversationId,
    domain,
    url: candidate.url,
    title: candidate.title,
    snippet: candidate.snippet,
    contentDigest: candidate.contentDigest,
    sourceTool: name,
    meta: {
      source,
      session_id: sessionId ?? null,
    },
  });
}

export async function getFreshWebArtifactForToolCall({
  conversationId,
  domain,
  url,
}: {
  conversationId: string | null | undefined;
  domain: string | null | undefined;
  url?: string | null;
}) {
  const conversationKey = normalizeConversationId(conversationId);
  const normalizedDomain = domain ? normalizeDomain(domain) : null;
  const normalizedUrl = typeof url === "string" ? normalizeWebUrl(url) : null;

  if (!conversationKey || !normalizedDomain || !webArtifactsEnabled()) {
    return null;
  }

  await ensureSchema();
  const result = await query<WebArtifactFreshRow>(
    `
      SELECT
        id,
        conversation_id,
        domain,
        url,
        normalized_url,
        title,
        snippet,
        content_digest,
        source_tool,
        fetched_at,
        ttl_seconds,
        meta,
        created_at,
        EXTRACT(EPOCH FROM (NOW() - fetched_at))::int AS age_seconds,
        (
          EXTRACT(EPOCH FROM (NOW() - fetched_at))
          <= COALESCE(ttl_seconds, $4)
        ) AS is_fresh
      FROM web_artifacts
      WHERE conversation_id = $1
        AND domain = $2
        AND ($3::text IS NULL OR normalized_url = $3)
      ORDER BY
        CASE WHEN $3::text IS NOT NULL AND normalized_url = $3 THEN 0 ELSE 1 END,
        fetched_at DESC
      LIMIT 1
    `,
    [conversationKey, normalizedDomain, normalizedUrl, WEB_ARTIFACT_TTL_SECONDS]
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }
  const mapped = mapFreshRow(row);
  return mapped.isFresh ? mapped : null;
}

export async function listRecentWebArtifacts({
  conversationId,
  domain,
  limit = 8,
}: {
  conversationId: string | null | undefined;
  domain?: string | null;
  limit?: number;
}) {
  const conversationKey = normalizeConversationId(conversationId);
  const normalizedDomain = domain ? normalizeDomain(domain) : null;
  if (!conversationKey || !webArtifactsEnabled()) {
    return [] as WebArtifactRecord[];
  }

  const safeLimit = Math.min(20, Math.max(1, Math.floor(limit)));
  await ensureSchema();
  const result = await query<WebArtifactRow>(
    `
      SELECT
        id,
        conversation_id,
        domain,
        url,
        normalized_url,
        title,
        snippet,
        content_digest,
        source_tool,
        fetched_at,
        ttl_seconds,
        meta,
        created_at
      FROM web_artifacts
      WHERE conversation_id = $1
        AND ($2::text IS NULL OR domain = $2)
      ORDER BY fetched_at DESC
      LIMIT $3
    `,
    [conversationKey, normalizedDomain, safeLimit]
  );

  return result.rows.map((row) => mapRow(row));
}

export async function getWebArtifactContextBlock(
  conversationId: string | null | undefined,
  limit = 5
) {
  const conversationKey = normalizeConversationId(conversationId);
  if (!conversationKey || !webArtifactsEnabled()) {
    return null;
  }

  await ensureSchema();
  const safeLimit = Math.min(10, Math.max(1, Math.floor(limit)));
  const result = await query<WebArtifactRow>(
    `
      SELECT
        id,
        conversation_id,
        domain,
        url,
        normalized_url,
        title,
        snippet,
        content_digest,
        source_tool,
        fetched_at,
        ttl_seconds,
        meta,
        created_at
      FROM web_artifacts
      WHERE conversation_id = $1
      ORDER BY fetched_at DESC
      LIMIT $2
    `,
    [conversationKey, safeLimit]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const lines = result.rows.map((row) => {
    const stamp = new Date(row.fetched_at).toISOString();
    const title = row.title ? ` title=${JSON.stringify(truncateText(row.title, 100))}` : "";
    return `- domain=${row.domain} source=${row.source_tool} fetched=${stamp}${title} url=${row.url}`;
  });

  return `Recent web artifacts:\n${lines.join("\n")}`;
}

export async function getWebArtifactsStats() {
  if (!webArtifactsEnabled()) {
    return {
      enabled: false,
      total: 0,
      fresh: 0,
      latestFetchedAt: null as string | null,
    };
  }

  await ensureSchema();
  const defaultTtl = WEB_ARTIFACT_TTL_SECONDS;
  const result = await query<{
    total_count: string;
    fresh_count: string;
    latest_fetched_at: string | null;
  }>(
    `
      SELECT
        COUNT(*)::text AS total_count,
        COUNT(*) FILTER (
          WHERE fetched_at + (COALESCE(ttl_seconds, $1)::text || ' seconds')::interval > NOW()
        )::text AS fresh_count,
        MAX(fetched_at) AS latest_fetched_at
      FROM web_artifacts
    `,
    [defaultTtl]
  );

  const row = result.rows[0];
  return {
    enabled: true,
    total: Number(row?.total_count ?? 0),
    fresh: Number(row?.fresh_count ?? 0),
    latestFetchedAt: row?.latest_fetched_at ?? null,
  };
}
