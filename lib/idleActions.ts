import { randomUUID } from "node:crypto";
import { ensureSchema, query } from "./db";
import { redactSensitivePayload, redactToolLogPayload } from "./webRedaction";

export type IdleAction = {
  type: string;
  rationale?: string;
  content?: string;
  safety_notes?: string;
  requires_user_confirmation?: boolean;
};

export type IdleActionLogEntry = {
  id: string;
  actionType: string;
  summary: string;
  source: string;
  model?: string | null;
  planId?: string | null;
  createdAt: string;
};

export type IdleActionPlan = {
  id: string;
  thoughtText: string;
  seedId: string;
  seedSource: string;
  actions: IdleAction[];
  status: string;
  model?: string | null;
  createdAt: string;
};

type SaveIdleActionPlanInput = {
  thoughtText: string;
  seedId: string;
  seedSource: string;
  actions: IdleAction[];
  model?: string | null;
};

type IdleActionPlanRow = {
  id: string;
  thought_text: string;
  seed_id: string;
  seed_source: string;
  actions: unknown;
  status: string;
  model: string | null;
  created_at: string;
};

type IdleActionLogRow = {
  id: string;
  action_type: string;
  summary: string;
  source: string;
  model: string | null;
  plan_id: string | null;
  created_at: string;
};

type SaveIdleActionLogInput = {
  planId?: string | null;
  thoughtText?: string | null;
  actions: IdleAction[];
  model?: string | null;
  source: "queued" | "executed";
};

const ACTION_LOG_SUMMARY_LIMIT = 200;

function truncateLogText(text: string, maxLength: number) {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxLength - 3))}...`;
}

function buildActionSummary(
  action: IdleAction,
  thoughtText: string,
  source: "queued" | "executed"
) {
  const prefix = source === "executed" ? "Executed" : "Queued";
  const detail =
    action.content?.trim() ||
    action.rationale?.trim() ||
    thoughtText.trim();
  const suffix = detail ? `: ${truncateLogText(detail, ACTION_LOG_SUMMARY_LIMIT)}` : "";
  return `Assistant ${prefix.toLowerCase()} ${action.type}${suffix}`;
}

function parseActionList(raw: unknown): IdleAction[] {
  if (!raw) {
    return [];
  }
  const parsed =
    typeof raw === "string"
      ? (() => {
          try {
            return JSON.parse(raw);
          } catch {
            return null;
          }
        })()
      : raw;
  if (!Array.isArray(parsed)) {
    return [];
  }
  const items = parsed
    .filter((entry) => entry && typeof entry === "object")
    .map((entry): IdleAction | null => {
      const record = entry as Record<string, unknown>;
      const type = typeof record.type === "string" ? record.type : "";
      if (!type) {
        return null;
      }
      return {
        type,
        rationale: typeof record.rationale === "string" ? record.rationale : undefined,
        content: typeof record.content === "string" ? record.content : undefined,
        safety_notes:
          typeof record.safety_notes === "string"
            ? record.safety_notes
            : typeof record.safety === "string"
              ? record.safety
              : undefined,
        requires_user_confirmation:
          typeof record.requires_user_confirmation === "boolean"
            ? record.requires_user_confirmation
            : undefined,
      };
    });

  return items.filter((entry): entry is IdleAction => entry !== null);
}

export async function saveIdleActionPlan({
  thoughtText,
  seedId,
  seedSource,
  actions,
  model,
}: SaveIdleActionPlanInput) {
  if (!thoughtText.trim() || !seedId.trim() || actions.length === 0) {
    return { status: "skipped" as const };
  }
  await ensureSchema();
  const id = randomUUID();
  await query(
    `
      INSERT INTO idle_action_queue (id, thought_text, seed_id, seed_source, actions, model)
      VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [id, thoughtText.trim(), seedId.trim(), seedSource.trim(), JSON.stringify(actions), model ?? null]
  );
  try {
    await saveIdleActionLogEntries({
      planId: id,
      thoughtText,
      actions,
      model,
      source: "queued",
    });
  } catch (error) {
    console.warn("Idle action log write failed.", error);
  }
  return { status: "ok" as const, id };
}

export async function saveIdleActionLogEntries({
  planId,
  thoughtText,
  actions,
  model,
  source,
}: SaveIdleActionLogInput) {
  if (!actions.length) {
    return { status: "skipped" as const };
  }
  const thought = thoughtText?.trim() ?? "";
  await ensureSchema();
  let savedCount = 0;
  await Promise.all(
    actions.map(async (action) => {
      const type = action.type?.trim();
      if (!type) {
        return;
      }
      const id = randomUUID();
      const summary = buildActionSummary(action, thought, source);
      const payload = {
        ...action,
        thought_text: thought || null,
        source,
      };
      const redactedPayload = redactSensitivePayload(payload);
      await query(
        `
          INSERT INTO idle_action_log (id, action_type, summary, action_data, source, plan_id, model)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
        [
          id,
          type,
          summary,
          JSON.stringify(redactedPayload),
          source,
          planId ?? null,
          model ?? null,
        ]
      );
      savedCount += 1;
    })
  );
  return { status: "ok" as const, count: savedCount };
}

export async function saveChatToolLog({
  actionType,
  summary,
  actionData,
  metadata,
  model,
}: {
  actionType: string;
  summary: string;
  actionData?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  model?: string | null;
}) {
  await ensureSchema();
  const id = randomUUID();
  const payload = actionData
    ? redactToolLogPayload({
        args: actionData.args,
        result: actionData.result,
        metadata,
      })
    : metadata
      ? { metadata: redactSensitivePayload(metadata) }
      : null;

  await query(
    `
      INSERT INTO idle_action_log (id, action_type, summary, action_data, source, model)
      VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [
      id,
      actionType,
      summary,
      payload ? JSON.stringify(payload) : null,
      "chat",
      model ?? null,
    ]
  );
  return { status: "ok" as const, id };
}

export async function listIdleActionLogEntries(limit: number) {
  const safeLimit = Math.min(50, Math.max(1, Math.floor(limit)));
  await ensureSchema();

  const result = await query<IdleActionLogRow>(
    `
      SELECT id, action_type, summary, source, model, plan_id, created_at
      FROM idle_action_log
      ORDER BY created_at DESC
      LIMIT $1
    `,
    [safeLimit]
  );

  return result.rows.map((row) => ({
    id: row.id,
    actionType: row.action_type,
    summary: row.summary,
    source: row.source,
    model: row.model ?? undefined,
    planId: row.plan_id ?? undefined,
    createdAt: row.created_at,
  })) satisfies IdleActionLogEntry[];
}

export async function listRecentToolActionTypes({
  limit = 5,
  source = "chat",
}: {
  limit?: number;
  source?: string;
}) {
  const safeLimit = Math.min(50, Math.max(1, Math.floor(limit)));
  await ensureSchema();
  const result = await query<{ action_type: string }>(
    `
      SELECT action_type
      FROM idle_action_log
      WHERE source = $2
      ORDER BY created_at DESC
      LIMIT $1
    `,
    [safeLimit, source]
  );
  return result.rows
    .map((row) => row.action_type)
    .filter((name) => typeof name === "string" && name.trim().length > 0);
}

export function formatIdleActionLogEntries(entries: IdleActionLogEntry[]) {
  if (entries.length === 0) {
    return "None";
  }
  return entries
    .map((entry) => `${new Date(entry.createdAt).toISOString()} - ${entry.summary}`)
    .join("\n");
}

export async function listIdleActionPlans(
  limit: number,
  offset: number,
  status?: string | null
) {
  const safeLimit = Math.min(200, Math.max(1, Math.floor(limit)));
  const safeOffset = Math.max(0, Math.floor(offset));
  const statusFilter = typeof status === "string" && status.trim() ? status.trim() : null;

  await ensureSchema();
  const countResult = await query<{ count: string }>(
    statusFilter
      ? "SELECT COUNT(*)::text AS count FROM idle_action_queue WHERE status = $1"
      : "SELECT COUNT(*)::text AS count FROM idle_action_queue",
    statusFilter ? [statusFilter] : []
  );
  const total = Number(countResult.rows[0]?.count ?? 0);

  const params: unknown[] = [safeLimit, safeOffset];
  let whereClause = "";
  if (statusFilter) {
    whereClause = "WHERE status = $3";
    params.push(statusFilter);
  }

  const result = await query<IdleActionPlanRow>(
    `
      SELECT id, thought_text, seed_id, seed_source, actions, status, model, created_at
      FROM idle_action_queue
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
    `,
    params
  );

  const items: IdleActionPlan[] = result.rows.map((row) => ({
    id: row.id,
    thoughtText: row.thought_text,
    seedId: row.seed_id,
    seedSource: row.seed_source,
    actions: parseActionList(row.actions),
    status: row.status,
    model: row.model ?? undefined,
    createdAt: row.created_at,
  }));

  return { total, items };
}

export async function getIdleActionPlanById(id: string) {
  const trimmed = id.trim();
  if (!trimmed) {
    return null;
  }
  await ensureSchema();
  const result = await query<IdleActionPlanRow>(
    `
      SELECT id, thought_text, seed_id, seed_source, actions, status, model, created_at
      FROM idle_action_queue
      WHERE id = $1
      LIMIT 1
    `,
    [trimmed]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    thoughtText: row.thought_text,
    seedId: row.seed_id,
    seedSource: row.seed_source,
    actions: parseActionList(row.actions),
    status: row.status,
    model: row.model ?? undefined,
    createdAt: row.created_at,
  } satisfies IdleActionPlan;
}

export async function updateIdleActionStatus(id: string, status: string) {
  const trimmed = id.trim();
  if (!trimmed || !status.trim()) {
    return { status: "skipped" as const };
  }
  await ensureSchema();
  await query(
    `
      UPDATE idle_action_queue
      SET status = $1
      WHERE id = $2
    `,
    [status.trim(), trimmed]
  );
  return { status: "ok" as const };
}
