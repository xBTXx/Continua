import { randomUUID } from "node:crypto";
import { ensureSchema, query } from "./db";
import type { MemorySnippet } from "./retrieval";

type RollingMemoryScope = "main" | "personal";

type RollingMemoryRow = {
  id: string;
  conversation_id: string;
  scope: RollingMemoryScope;
  memory_id: string;
  content: string;
  metadata: unknown;
  memory_created_at: string | null;
  added_at: string;
  last_seen_at: string;
};

type RollingMemoryCandidate = {
  scope: RollingMemoryScope;
  memoryId: string;
  snippet: MemorySnippet;
};

type RollingMemoryUpdateInput = {
  conversationId: string;
  mainCandidates: MemorySnippet[];
  personalCandidates: MemorySnippet[];
};

type RollingMemoryUpdateResult = {
  main: MemorySnippet[];
  personal: MemorySnippet[];
};

type RollingMemoryMetadata = {
  createdAt?: unknown;
  sourceAt?: unknown;
  conversationId?: unknown;
  sourceMessageIds?: unknown;
  sourceMessageStartId?: unknown;
  sourceMessageEndId?: unknown;
  sourceMessageCount?: unknown;
  resonancePrimary?: unknown;
  resonanceTagsFlat?: unknown;
  resonanceWeight?: unknown;
  resonanceIntensity?: unknown;
  resonanceState?: unknown;
};

const MAX_TOTAL = parseEnvNumber(
  process.env.ROLLING_MEMORY_MAX_TOTAL,
  15,
  { min: 1, max: 50 }
);
const MAX_MAIN = parseEnvNumber(
  process.env.ROLLING_MEMORY_MAX_MAIN,
  Math.min(10, MAX_TOTAL),
  { min: 0, max: MAX_TOTAL }
);
const MAX_PERSONAL = parseEnvNumber(
  process.env.ROLLING_MEMORY_MAX_PERSONAL,
  Math.min(5, MAX_TOTAL),
  { min: 0, max: MAX_TOTAL }
);
const ADD_MAIN = parseEnvNumber(
  process.env.ROLLING_MEMORY_ADD_MAIN,
  3,
  { min: 0, max: 10 }
);
const ADD_PERSONAL = parseEnvNumber(
  process.env.ROLLING_MEMORY_ADD_PERSONAL,
  3,
  { min: 0, max: 10 }
);
const TTL_DAYS = parseEnvNumber(
  process.env.ROLLING_MEMORY_TTL_DAYS,
  14,
  { min: 0, max: 365 }
);

function parseEnvNumber(
  value: string | undefined,
  fallback: number,
  options?: { min?: number; max?: number }
) {
  if (!value || value.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  let normalized = Math.floor(parsed);
  if (typeof options?.min === "number") {
    normalized = Math.max(options.min, normalized);
  }
  if (typeof options?.max === "number") {
    normalized = Math.min(options.max, normalized);
  }
  return normalized;
}

function normalizeString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function normalizeNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeStringArray(value: unknown) {
  if (Array.isArray(value)) {
    const items = value
      .map((entry) => normalizeString(entry))
      .filter((entry): entry is string => Boolean(entry));
    return items.length > 0 ? items : undefined;
  }
  return undefined;
}

function normalizeContentKey(value: string) {
  return value.trim().toLowerCase();
}

function getMemoryIdentity(
  snippet: MemorySnippet,
  scope: RollingMemoryScope
) {
  const content = normalizeString(snippet.content);
  if (!content) {
    return null;
  }
  const id = normalizeString(snippet.id);
  const memoryId = id ?? normalizeContentKey(content);
  return {
    key: `${scope}:${memoryId}`,
    memoryId,
    content,
  };
}

function compactRecord<T extends Record<string, unknown>>(record: T) {
  const result: Record<string, unknown> = {};
  Object.entries(record).forEach(([key, value]) => {
    if (value !== undefined) {
      result[key] = value;
    }
  });
  return result;
}

function buildMetadata(snippet: MemorySnippet) {
  return compactRecord({
    createdAt: snippet.createdAt,
    sourceAt: snippet.sourceAt,
    conversationId: snippet.conversationId,
    sourceMessageIds: snippet.sourceMessageIds,
    sourceMessageStartId: snippet.sourceMessageStartId,
    sourceMessageEndId: snippet.sourceMessageEndId,
    sourceMessageCount: snippet.sourceMessageCount,
    resonancePrimary: snippet.resonancePrimary,
    resonanceTagsFlat: snippet.resonanceTagsFlat,
    resonanceWeight: snippet.resonanceWeight,
    resonanceIntensity: snippet.resonanceIntensity,
    resonanceState: snippet.resonanceState,
  });
}

function parseMetadata(raw: unknown) {
  if (!raw) {
    return {};
  }
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  if (typeof raw === "object") {
    return raw as Record<string, unknown>;
  }
  return {};
}

function rowToSnippet(row: RollingMemoryRow): MemorySnippet {
  const metadata = parseMetadata(row.metadata) as RollingMemoryMetadata;
  return {
    id: normalizeString(row.memory_id),
    content: row.content,
    createdAt:
      normalizeString(metadata.createdAt) ??
      normalizeString(row.memory_created_at),
    sourceAt: normalizeString(metadata.sourceAt),
    conversationId: normalizeString(metadata.conversationId),
    sourceMessageIds: normalizeStringArray(metadata.sourceMessageIds),
    sourceMessageStartId: normalizeString(metadata.sourceMessageStartId),
    sourceMessageEndId: normalizeString(metadata.sourceMessageEndId),
    sourceMessageCount: normalizeNumber(metadata.sourceMessageCount),
    resonancePrimary: normalizeString(metadata.resonancePrimary),
    resonanceTagsFlat: normalizeString(metadata.resonanceTagsFlat),
    resonanceWeight: normalizeString(metadata.resonanceWeight),
    resonanceIntensity: normalizeNumber(metadata.resonanceIntensity),
    resonanceState: normalizeString(metadata.resonanceState),
  };
}

function pickRollingCandidates(
  candidates: MemorySnippet[],
  scope: RollingMemoryScope,
  existingMap: Map<string, RollingMemoryRow>,
  addLimit: number
) {
  const upserts: RollingMemoryCandidate[] = [];
  const seen = new Set<string>();
  let added = 0;

  for (const candidate of candidates) {
    const identity = getMemoryIdentity(candidate, scope);
    if (!identity) {
      continue;
    }
    if (seen.has(identity.key)) {
      continue;
    }
    seen.add(identity.key);

    const contentKey = `${scope}:${normalizeContentKey(identity.content)}`;
    const existing =
      existingMap.get(identity.key) ?? existingMap.get(contentKey);
    if (existing) {
      upserts.push({
        scope,
        memoryId: existing.memory_id,
        snippet: candidate,
      });
      continue;
    }

    if (added >= addLimit) {
      continue;
    }

    upserts.push({
      scope,
      memoryId: identity.memoryId,
      snippet: candidate,
    });
    added += 1;
  }

  return upserts;
}

async function listRollingMemoryRows(conversationId: string) {
  await ensureSchema();
  const result = await query<RollingMemoryRow>(
    `
      SELECT id, conversation_id, scope, memory_id, content, metadata,
             memory_created_at, added_at, last_seen_at
      FROM conversation_memory_log
      WHERE conversation_id = $1
    `,
    [conversationId]
  );
  return result.rows;
}

async function upsertRollingMemoryEntries(
  conversationId: string,
  candidates: RollingMemoryCandidate[]
) {
  if (candidates.length === 0) {
    return;
  }
  await ensureSchema();
  for (const candidate of candidates) {
    const snippet = candidate.snippet;
    const content = normalizeString(snippet.content);
    if (!content || !candidate.memoryId) {
      continue;
    }
    const metadata = buildMetadata(snippet);
    const memoryCreatedAt = normalizeString(snippet.sourceAt) ??
      normalizeString(snippet.createdAt) ??
      null;
    const rowId = randomUUID();
    await query(
      `
        INSERT INTO conversation_memory_log
          (id, conversation_id, scope, memory_id, content, metadata, memory_created_at, last_seen_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        ON CONFLICT (conversation_id, scope, memory_id)
        DO UPDATE SET
          content = EXCLUDED.content,
          metadata = EXCLUDED.metadata,
          memory_created_at = EXCLUDED.memory_created_at,
          last_seen_at = EXCLUDED.last_seen_at
      `,
      [
        rowId,
        conversationId,
        candidate.scope,
        candidate.memoryId,
        content,
        JSON.stringify(metadata),
        memoryCreatedAt,
      ]
    );
  }
}

function sortByLastSeen(a: RollingMemoryRow, b: RollingMemoryRow) {
  if (a.last_seen_at === b.last_seen_at) {
    return a.added_at.localeCompare(b.added_at);
  }
  return a.last_seen_at.localeCompare(b.last_seen_at);
}

async function trimRollingMemoryLog(conversationId: string) {
  if (TTL_DAYS > 0) {
    const cutoff = new Date(
      Date.now() - TTL_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();
    await query(
      `
        DELETE FROM conversation_memory_log
        WHERE conversation_id = $1
          AND last_seen_at < $2
      `,
      [conversationId, cutoff]
    );
  }

  const rows = await listRollingMemoryRows(conversationId);
  if (rows.length === 0) {
    return;
  }

  const deletions = new Set<string>();
  const mainRows = rows.filter((row) => row.scope === "main");
  const personalRows = rows.filter((row) => row.scope === "personal");

  if (MAX_MAIN === 0 && mainRows.length > 0) {
    mainRows.forEach((row) => deletions.add(row.id));
  } else if (MAX_MAIN > 0 && mainRows.length > MAX_MAIN) {
    const sorted = [...mainRows].sort(sortByLastSeen);
    const overflow = sorted.slice(0, mainRows.length - MAX_MAIN);
    overflow.forEach((row) => deletions.add(row.id));
  }

  if (MAX_PERSONAL === 0 && personalRows.length > 0) {
    personalRows.forEach((row) => deletions.add(row.id));
  } else if (MAX_PERSONAL > 0 && personalRows.length > MAX_PERSONAL) {
    const sorted = [...personalRows].sort(sortByLastSeen);
    const overflow = sorted.slice(0, personalRows.length - MAX_PERSONAL);
    overflow.forEach((row) => deletions.add(row.id));
  }

  const remaining = rows.filter((row) => !deletions.has(row.id));
  if (MAX_TOTAL > 0 && remaining.length > MAX_TOTAL) {
    const sorted = [...remaining].sort(sortByLastSeen);
    const overflow = sorted.slice(0, remaining.length - MAX_TOTAL);
    overflow.forEach((row) => deletions.add(row.id));
  }

  const ids = Array.from(deletions);
  if (ids.length === 0) {
    return;
  }

  await query(
    `
      DELETE FROM conversation_memory_log
      WHERE id = ANY($1::uuid[])
    `,
    [ids]
  );
}

async function listRollingMemories(
  conversationId: string,
  scope: RollingMemoryScope
) {
  await ensureSchema();
  const result = await query<RollingMemoryRow>(
    `
      SELECT id, conversation_id, scope, memory_id, content, metadata,
             memory_created_at, added_at, last_seen_at
      FROM conversation_memory_log
      WHERE conversation_id = $1
        AND scope = $2
      ORDER BY added_at ASC
    `,
    [conversationId, scope]
  );
  return result.rows.map(rowToSnippet);
}

export async function updateRollingMemoryLog({
  conversationId,
  mainCandidates,
  personalCandidates,
}: RollingMemoryUpdateInput): Promise<RollingMemoryUpdateResult> {
  const rows = await listRollingMemoryRows(conversationId);
  const existingMap = new Map<string, RollingMemoryRow>();
  for (const row of rows) {
    existingMap.set(`${row.scope}:${row.memory_id}`, row);
    existingMap.set(`${row.scope}:${normalizeContentKey(row.content)}`, row);
  }

  const mainUpserts = pickRollingCandidates(
    mainCandidates,
    "main",
    existingMap,
    ADD_MAIN
  );
  const personalUpserts = pickRollingCandidates(
    personalCandidates,
    "personal",
    existingMap,
    ADD_PERSONAL
  );

  await upsertRollingMemoryEntries(conversationId, [
    ...mainUpserts,
    ...personalUpserts,
  ]);
  await trimRollingMemoryLog(conversationId);

  const [main, personal] = await Promise.all([
    listRollingMemories(conversationId, "main"),
    listRollingMemories(conversationId, "personal"),
  ]);

  return { main, personal };
}
