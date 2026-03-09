import { randomUUID } from "node:crypto";
import { ensureSchema, query } from "./db";

const SCRATCHPAD_ASSISTANT_WINDOW_DEFAULT = 5;
const SCRATCHPAD_NOTE_LIMIT_DEFAULT = 12;
const parsedAssistantWindow = Number(
  process.env.SCRATCHPAD_ASSISTANT_WINDOW ?? `${SCRATCHPAD_ASSISTANT_WINDOW_DEFAULT}`
);
const parsedNoteLimit = Number(
  process.env.SCRATCHPAD_NOTE_LIMIT ?? `${SCRATCHPAD_NOTE_LIMIT_DEFAULT}`
);

export const SCRATCHPAD_ASSISTANT_WINDOW =
  Number.isFinite(parsedAssistantWindow) && parsedAssistantWindow > 0
    ? parsedAssistantWindow
    : SCRATCHPAD_ASSISTANT_WINDOW_DEFAULT;
export const SCRATCHPAD_NOTE_LIMIT =
  Number.isFinite(parsedNoteLimit) && parsedNoteLimit > 0
    ? parsedNoteLimit
    : SCRATCHPAD_NOTE_LIMIT_DEFAULT;

export type ScratchpadTargetPhase = "active" | "idle";

export type ScratchpadNote = {
  id: string;
  content: string;
  createdAt: string;
  assignedConversationId?: string | null;
  assignedAt?: string | null;
  idleProcessedAt?: string | null;
  consumedAt?: string | null;
  targetPhase?: ScratchpadTargetPhase | null;
};

type SaveScratchpadNoteInput = {
  content: string;
  model?: string | null;
  metadata?: Record<string, string | number | boolean | null>;
  idleQueue?: "allow" | "skip";
  targetPhase?: ScratchpadTargetPhase;
};

type ScratchpadNoteRow = {
  id: string;
  content: string;
  created_at: string;
  assigned_conversation_id: string | null;
  assigned_at: string | null;
  idle_processed_at: string | null;
  consumed_at: string | null;
  target_phase: string | null;
};

function normalizeTargetPhase(value?: string | null): ScratchpadTargetPhase | null {
  if (value === "active" || value === "idle") {
    return value;
  }
  return null;
}

function buildTargetPhaseFilter(targetPhase: ScratchpadTargetPhase) {
  if (targetPhase === "idle") {
    return "(target_phase = 'idle' OR (target_phase IS NULL AND idle_processed_at IS NULL))";
  }
  return "(target_phase = 'active' OR (target_phase IS NULL AND idle_processed_at IS NOT NULL))";
}

function mapScratchpadNote(row: ScratchpadNoteRow): ScratchpadNote {
  return {
    id: row.id,
    content: row.content,
    createdAt: row.created_at,
    assignedConversationId: row.assigned_conversation_id,
    assignedAt: row.assigned_at,
    idleProcessedAt: row.idle_processed_at,
    consumedAt: row.consumed_at,
    targetPhase: normalizeTargetPhase(row.target_phase),
  };
}

async function insertScratchpadRecord({
  id,
  content,
  model,
  metadata,
  idleProcessedAt,
  targetPhase,
}: {
  id: string;
  content: string;
  model?: string | null;
  metadata?: Record<string, string | number | boolean | null>;
  idleProcessedAt?: string | null;
  targetPhase?: ScratchpadTargetPhase | null;
}) {
  await ensureSchema();
  await query(
    `
      INSERT INTO scratchpad_notes (id, content, metadata, model, idle_processed_at, target_phase)
      VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [
      id,
      content,
      metadata ? JSON.stringify(metadata) : null,
      model ?? null,
      idleProcessedAt ?? null,
      targetPhase ?? null,
    ]
  );
}

export async function saveScratchpadNote({
  content,
  model,
  metadata,
  idleQueue = "allow",
  targetPhase,
}: SaveScratchpadNoteInput) {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error("Scratchpad note content is required.");
  }

  const id = randomUUID();
  const normalizedTarget = normalizeTargetPhase(targetPhase) ?? "active";
  const idleProcessedAt =
    idleQueue === "skip" ? new Date().toISOString() : null;
  await insertScratchpadRecord({
    id,
    content: trimmed,
    model,
    metadata,
    idleProcessedAt,
    targetPhase: normalizedTarget,
  });

  return { status: "ok", id };
}

export async function listActiveScratchpadNotes(
  limit = SCRATCHPAD_NOTE_LIMIT,
  options?: { targetPhase?: ScratchpadTargetPhase }
): Promise<ScratchpadNote[]> {
  await ensureSchema();
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
  const filters = ["consumed_at IS NULL"];
  if (options?.targetPhase) {
    filters.push(buildTargetPhaseFilter(options.targetPhase));
  }
  const whereClause = `WHERE ${filters.join(" AND ")}`;
  const result = await query<ScratchpadNoteRow>(
    `
      SELECT id, content, created_at, assigned_conversation_id, assigned_at,
             idle_processed_at, consumed_at, target_phase
      FROM scratchpad_notes
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $1
    `,
    [safeLimit]
  );
  return result.rows.map(mapScratchpadNote);
}

export async function listScratchpadNotesForConversation(
  conversationId: string,
  limit = SCRATCHPAD_NOTE_LIMIT,
  options?: { consumeOnAssign?: boolean }
): Promise<ScratchpadNote[]> {
  const trimmed = conversationId.trim();
  if (!trimmed) {
    return [];
  }
  await ensureSchema();
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
  const targetFilter = buildTargetPhaseFilter("active");
  await query(
    `
      UPDATE scratchpad_notes
      SET assigned_conversation_id = $1,
          assigned_at = NOW()
      WHERE consumed_at IS NULL
        AND assigned_conversation_id IS NULL
        AND ${targetFilter}
    `,
    [trimmed]
  );
  const result = await query<ScratchpadNoteRow>(
    `
      SELECT id, content, created_at, assigned_conversation_id, assigned_at,
             idle_processed_at, consumed_at, target_phase
      FROM scratchpad_notes
      WHERE consumed_at IS NULL
        AND assigned_conversation_id = $1
        AND ${targetFilter}
      ORDER BY created_at DESC
      LIMIT $2
    `,
    [trimmed, safeLimit]
  );
  const notes = result.rows.map(mapScratchpadNote);
  if (options?.consumeOnAssign && notes.length > 0) {
    await query(
      `
        UPDATE scratchpad_notes
        SET consumed_at = NOW(),
            consumed_conversation_id = $1
        WHERE consumed_at IS NULL
          AND assigned_conversation_id = $1
          AND ${targetFilter}
      `,
      [trimmed]
    );
  }
  return notes;
}

export async function listScratchpadNotes({
  limit = SCRATCHPAD_NOTE_LIMIT,
  offset = 0,
  status = "active",
}: {
  limit?: number;
  offset?: number;
  status?: "active" | "consumed" | "all";
}) {
  await ensureSchema();
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const safeOffset = Math.max(0, Math.floor(offset));
  const filters: string[] = [];
  if (status === "active") {
    filters.push("consumed_at IS NULL");
  } else if (status === "consumed") {
    filters.push("consumed_at IS NOT NULL");
  }
  const whereClause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";

  const countResult = await query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM scratchpad_notes
      ${whereClause}
    `
  );
  const total = Number(countResult.rows[0]?.count ?? 0);

  const result = await query<ScratchpadNoteRow>(
    `
      SELECT id, content, created_at, assigned_conversation_id, assigned_at,
             idle_processed_at, consumed_at, target_phase
      FROM scratchpad_notes
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
    `,
    [safeLimit, safeOffset]
  );

  return { total, items: result.rows.map(mapScratchpadNote) };
}

export async function updateScratchpadNote(noteId: string, content: string) {
  const trimmedId = noteId.trim();
  const trimmedContent = content.trim();
  if (!trimmedId) {
    throw new Error("Scratchpad note id is required.");
  }
  if (!trimmedContent) {
    throw new Error("Scratchpad note content is required.");
  }
  await ensureSchema();
  const result = await query<ScratchpadNoteRow>(
    `
      UPDATE scratchpad_notes
      SET content = $2
      WHERE id = $1
      RETURNING id, content, created_at, assigned_conversation_id, assigned_at,
                idle_processed_at, consumed_at, target_phase
    `,
    [trimmedId, trimmedContent]
  );
  if (result.rowCount === 0) {
    return null;
  }
  return mapScratchpadNote(result.rows[0]);
}

export async function deleteScratchpadNote(noteId: string) {
  const trimmedId = noteId.trim();
  if (!trimmedId) {
    throw new Error("Scratchpad note id is required.");
  }
  await ensureSchema();
  const result = await query<{ id: string }>(
    `
      DELETE FROM scratchpad_notes
      WHERE id = $1
      RETURNING id
    `,
    [trimmedId]
  );
  return result.rowCount ?? 0;
}

export async function listScratchpadNotesForIdle(limit = 1) {
  await ensureSchema();
  const safeLimit = Math.max(1, Math.min(10, Math.floor(limit)));
  const targetFilter = buildTargetPhaseFilter("idle");
  const result = await query<ScratchpadNoteRow>(
    `
      SELECT id, content, created_at, assigned_conversation_id, assigned_at,
             idle_processed_at, consumed_at, target_phase
      FROM scratchpad_notes
      WHERE consumed_at IS NULL
        AND idle_processed_at IS NULL
        AND ${targetFilter}
      ORDER BY created_at ASC
      LIMIT $1
    `,
    [safeLimit]
  );
  return result.rows.map(mapScratchpadNote);
}

export async function markScratchpadNoteIdleProcessed(noteId: string) {
  const trimmed = noteId.trim();
  if (!trimmed) {
    return 0;
  }
  await ensureSchema();
  const result = await query(
    `
      UPDATE scratchpad_notes
      SET idle_processed_at = NOW(),
          consumed_at = NOW()
      WHERE id = $1
    `,
    [trimmed]
  );
  return result.rowCount ?? 0;
}

export async function consumeScratchpadNotesByTarget(
  targetPhase: ScratchpadTargetPhase
) {
  await ensureSchema();
  const targetFilter = buildTargetPhaseFilter(targetPhase);
  const result = await query(
    `
      UPDATE scratchpad_notes
      SET consumed_at = NOW()
      WHERE consumed_at IS NULL
        AND ${targetFilter}
    `
  );
  return result.rowCount ?? 0;
}

export async function countAssistantMessages(conversationId: string) {
  const trimmed = conversationId.trim();
  if (!trimmed) {
    return 0;
  }
  await ensureSchema();
  const result = await query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM messages
      WHERE conversation_id = $1 AND role = 'assistant'
    `,
    [trimmed]
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function shouldInjectScratchpadNotes(
  conversationId: string
) {
  const trimmed = conversationId.trim();
  if (!trimmed) {
    return false;
  }
  await ensureSchema();
  const targetFilter = buildTargetPhaseFilter("active");
  const result = await query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM scratchpad_notes
      WHERE consumed_at IS NULL
        AND assigned_conversation_id IS NULL
        AND ${targetFilter}
    `
  );
  return Number(result.rows[0]?.count ?? 0) > 0;
}

export async function consumeScratchpadNotes(conversationId: string) {
  const trimmed = conversationId.trim();
  if (!trimmed) {
    return 0;
  }
  await ensureSchema();
  const result = await query<{ id: string }>(
    `
      UPDATE scratchpad_notes
      SET consumed_at = NOW(),
          consumed_conversation_id = $1
      WHERE consumed_at IS NULL
        AND assigned_conversation_id = $1
      RETURNING id
    `,
    [trimmed]
  );
  return result.rowCount ?? 0;
}
