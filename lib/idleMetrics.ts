import { randomUUID } from "node:crypto";
import { ensureSchema, query } from "./db";

export type IdleTickMetrics = {
  id: string;
  seedsCount: number;
  thoughtsGenerated: number;
  storedCount: number;
  escalatedCount: number;
  deferredCount: number;
  actionsQueued: number;
  scratchpadNotes: number;
  personaKeywordHits?: number;
  personaSemanticHits?: number;
  energy?: number | null;
  modelLite?: string | null;
  modelSmart?: string | null;
  error?: string | null;
  createdAt: string;
};

type IdleTickMetricsRow = {
  id: string;
  seeds_count: number;
  thoughts_generated: number;
  stored_count: number;
  escalated_count: number;
  deferred_count: number;
  actions_queued: number;
  scratchpad_notes: number;
  persona_keyword_hits: number | null;
  persona_semantic_hits: number | null;
  energy: number | null;
  model_lite: string | null;
  model_smart: string | null;
  error: string | null;
  created_at: string;
};

export async function saveIdleTickMetrics(input: Omit<IdleTickMetrics, "id" | "createdAt">) {
  await ensureSchema();
  const id = randomUUID();
  await query(
    `
      INSERT INTO idle_tick_log (
        id,
        seeds_count,
        thoughts_generated,
        stored_count,
        escalated_count,
        deferred_count,
        actions_queued,
        scratchpad_notes,
        persona_keyword_hits,
        persona_semantic_hits,
        model_lite,
        model_smart,
        energy,
        error
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    `,
    [
      id,
      input.seedsCount,
      input.thoughtsGenerated,
      input.storedCount,
      input.escalatedCount,
      input.deferredCount,
      input.actionsQueued,
      input.scratchpadNotes,
      input.personaKeywordHits ?? 0,
      input.personaSemanticHits ?? 0,
      input.modelLite ?? null,
      input.modelSmart ?? null,
      input.energy ?? null,
      input.error ?? null,
    ]
  );
  return { status: "ok" as const, id };
}

export async function listIdleTickMetrics(limit: number, offset: number) {
  const safeLimit = Math.min(200, Math.max(1, Math.floor(limit)));
  const safeOffset = Math.max(0, Math.floor(offset));
  await ensureSchema();

  const countResult = await query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM idle_tick_log"
  );
  const total = Number(countResult.rows[0]?.count ?? 0);

  const result = await query<IdleTickMetricsRow>(
    `
      SELECT id, seeds_count, thoughts_generated, stored_count, escalated_count,
             deferred_count, actions_queued, scratchpad_notes, persona_keyword_hits,
             persona_semantic_hits, energy, model_lite, model_smart, error, created_at
      FROM idle_tick_log
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
    `,
    [safeLimit, safeOffset]
  );

  const items: IdleTickMetrics[] = result.rows.map((row) => ({
    id: row.id,
    seedsCount: row.seeds_count,
    thoughtsGenerated: row.thoughts_generated,
    storedCount: row.stored_count,
    escalatedCount: row.escalated_count,
    deferredCount: row.deferred_count,
    actionsQueued: row.actions_queued,
    scratchpadNotes: row.scratchpad_notes,
    personaKeywordHits: row.persona_keyword_hits ?? 0,
    personaSemanticHits: row.persona_semantic_hits ?? 0,
    energy: row.energy,
    modelLite: row.model_lite,
    modelSmart: row.model_smart,
    error: row.error,
    createdAt: row.created_at,
  }));

  return { total, items };
}
