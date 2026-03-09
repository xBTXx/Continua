import { randomUUID } from "node:crypto";
import { ensureSchema, query } from "@/lib/db";

type SSEFAuditEventRow = {
  id: string;
  event_type: string;
  actor: string | null;
  skill_id: string | null;
  skill_version_id: string | null;
  proposal_id: string | null;
  run_id: string | null;
  payload: unknown;
  created_at: string;
};

export type SSEFAuditEvent = {
  id: string;
  eventType: string;
  actor: string | null;
  skillDbId: string | null;
  skillVersionId: string | null;
  proposalId: string | null;
  runId: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
};

export type AppendSSEFAuditEventInput = {
  eventType: string;
  actor?: string | null;
  skillDbId?: string | null;
  skillVersionId?: string | null;
  proposalId?: string | null;
  runId?: string | null;
  payload?: Record<string, unknown> | null;
};

export type ListSSEFAuditEventsOptions = {
  eventType?: string;
  skillDbId?: string;
  proposalId?: string;
  limit?: number;
};

function asNonEmptyText(value: string | null | undefined) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asObjectOrNull(value: unknown): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      ) {
        return parsed as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function mapAuditRow(row: SSEFAuditEventRow): SSEFAuditEvent {
  return {
    id: row.id,
    eventType: row.event_type,
    actor: row.actor,
    skillDbId: row.skill_id,
    skillVersionId: row.skill_version_id,
    proposalId: row.proposal_id,
    runId: row.run_id,
    payload: asObjectOrNull(row.payload),
    createdAt: row.created_at,
  };
}

function normalizeEventType(value: string) {
  const eventType = value.trim();
  if (!/^[a-z][a-z0-9_.:-]{2,127}$/.test(eventType)) {
    throw new Error(
      "eventType must be 3-128 chars and use lowercase letters, digits, dot, underscore, colon, or hyphen."
    );
  }
  return eventType;
}

function toSafeLimit(value: number | undefined) {
  const parsed = Number(value ?? 50);
  if (!Number.isFinite(parsed)) {
    return 50;
  }
  return Math.min(200, Math.max(1, Math.floor(parsed)));
}

export async function appendSSEFAuditEvent(
  input: AppendSSEFAuditEventInput
): Promise<SSEFAuditEvent> {
  await ensureSchema();
  const id = randomUUID();
  const eventType = normalizeEventType(input.eventType);
  const result = await query<SSEFAuditEventRow>(
    `
      INSERT INTO ssef_audit_events (
        id,
        event_type,
        actor,
        skill_id,
        skill_version_id,
        proposal_id,
        run_id,
        payload
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING
        id,
        event_type,
        actor,
        skill_id,
        skill_version_id,
        proposal_id,
        run_id,
        payload,
        created_at
    `,
    [
      id,
      eventType,
      asNonEmptyText(input.actor),
      asNonEmptyText(input.skillDbId),
      asNonEmptyText(input.skillVersionId),
      asNonEmptyText(input.proposalId),
      asNonEmptyText(input.runId),
      input.payload ? JSON.stringify(input.payload) : null,
    ]
  );
  return mapAuditRow(result.rows[0]);
}

export async function listSSEFAuditEvents(
  options: ListSSEFAuditEventsOptions = {}
): Promise<SSEFAuditEvent[]> {
  await ensureSchema();
  const limit = toSafeLimit(options.limit);
  const params: unknown[] = [limit];
  const where: string[] = [];

  const eventType = asNonEmptyText(options.eventType);
  if (eventType) {
    params.push(eventType);
    where.push(`event_type = $${params.length}`);
  }
  const skillDbId = asNonEmptyText(options.skillDbId);
  if (skillDbId) {
    params.push(skillDbId);
    where.push(`skill_id = $${params.length}`);
  }
  const proposalId = asNonEmptyText(options.proposalId);
  if (proposalId) {
    params.push(proposalId);
    where.push(`proposal_id = $${params.length}`);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const result = await query<SSEFAuditEventRow>(
    `
      SELECT
        id,
        event_type,
        actor,
        skill_id,
        skill_version_id,
        proposal_id,
        run_id,
        payload,
        created_at
      FROM ssef_audit_events
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $1
    `,
    params
  );

  return result.rows.map(mapAuditRow);
}
