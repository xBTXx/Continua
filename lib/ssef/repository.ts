import { randomUUID } from "node:crypto";
import { ensureSchema, query } from "@/lib/db";
import type { SkillLifecycleState } from "./contracts/lifecycle";
import {
  createInitialSkillLifecycleState,
  SKILL_LIFECYCLE_STATES,
} from "./contracts/lifecycle";
import type { SkillManifestV1 } from "./contracts/manifest";
import { validateSkillManifestV1 } from "./contracts/manifest";
import { appendSSEFAuditEvent } from "./audit";
import { syncSkillsIndexFromRepository } from "./registry/indexFile";

type SSEFSkillRow = {
  id: string;
  skill_id: string;
  name: string | null;
  description: string;
  lifecycle_state: string;
  latest_version: string | null;
  active_version: string | null;
  metadata: unknown;
  created_at: string;
  updated_at: string;
};

type SSEFSkillVersionRow = {
  id: string;
  skill_id: string;
  version: string;
  lifecycle_state: string;
  manifest: unknown;
  permissions: unknown;
  test_cases: unknown;
  context_keys: unknown;
  runtime: string;
  entrypoint: string;
  security_summary: unknown;
  source_proposal_id: string | null;
  metadata: unknown;
  created_at: string;
  updated_at: string;
};

type SSEFSkillVersionJoinedRow = SSEFSkillVersionRow & {
  skill_id_text: string;
};

type SSEFSkillVersionLifecycleUpdateRow = SSEFSkillVersionRow & {
  skill_db_id: string;
  skill_id_text: string;
};

type SSEFProposalRow = {
  id: string;
  proposal_type: string;
  status: string;
  skill_id: string | null;
  requested_by: string | null;
  title: string | null;
  summary: string | null;
  spark: unknown;
  constraints: unknown;
  priority: string | null;
  metadata: unknown;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
};

type SSEFRunRow = {
  id: string;
  proposal_id: string | null;
  skill_version_id: string | null;
  run_type: string;
  status: string;
  attempt: number;
  started_at: string;
  finished_at: string | null;
  stdout_log_path: string | null;
  stderr_log_path: string | null;
  trace_log_path: string | null;
  error: string | null;
  result: unknown;
  metadata: unknown;
  created_at: string;
};

type SSEFPolicyIncidentRow = {
  id: string;
  run_id: string | null;
  skill_version_id: string | null;
  severity: string;
  category: string;
  decision: string;
  message: string;
  details: unknown;
  created_at: string;
};

export type SSEFSkill = {
  id: string;
  skillId: string;
  name: string | null;
  description: string;
  lifecycleState: SkillLifecycleState;
  latestVersion: string | null;
  activeVersion: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

export type SSEFSkillVersion = {
  id: string;
  skillDbId: string;
  skillId: string;
  version: string;
  lifecycleState: SkillLifecycleState;
  manifest: SkillManifestV1;
  runtime: string;
  entrypoint: string;
  permissions: SkillManifestV1["permissions"];
  testCases: string[];
  contextKeys: string[];
  dependencies: string[];
  invocationGraph: SkillManifestV1["invocation_graph"];
  securitySummary: Record<string, unknown> | null;
  sourceProposalId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

export type SSEFProposal = {
  id: string;
  proposalType: string;
  status: string;
  skillDbId: string | null;
  requestedBy: string | null;
  title: string | null;
  summary: string | null;
  spark: Record<string, unknown>;
  constraints: Record<string, unknown> | null;
  priority: string | null;
  metadata: Record<string, unknown> | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SSEFRun = {
  id: string;
  proposalId: string | null;
  skillVersionId: string | null;
  runType: string;
  status: string;
  attempt: number;
  startedAt: string;
  finishedAt: string | null;
  stdoutLogPath: string | null;
  stderrLogPath: string | null;
  traceLogPath: string | null;
  error: string | null;
  result: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

export type SSEFPolicyIncident = {
  id: string;
  runId: string | null;
  skillVersionId: string | null;
  severity: string;
  category: string;
  decision: string;
  message: string;
  details: Record<string, unknown> | null;
  createdAt: string;
};

export type ListSSEFSkillsOptions = {
  limit?: number;
  offset?: number;
  search?: string;
  lifecycleState?: SkillLifecycleState | SkillLifecycleState[];
};

export type ListSSEFSkillsResult = {
  items: SSEFSkill[];
  total: number;
  limit: number;
  offset: number;
};

export type ListSSEFSkillVersionsOptions = {
  limit?: number;
  offset?: number;
};

export type ListSSEFSkillVersionsResult = {
  items: SSEFSkillVersion[];
  total: number;
  limit: number;
  offset: number;
};

export type ListSSEFActiveSkillVersionsOptions = {
  limit?: number;
  offset?: number;
};

export type ListSSEFActiveSkillVersionsResult = {
  items: SSEFSkillVersion[];
  total: number;
  limit: number;
  offset: number;
};

export type UpsertSSEFSkillInput = {
  skillId: string;
  name?: string | null;
  description: string;
  lifecycleState?: SkillLifecycleState;
  metadata?: Record<string, unknown> | null;
  actor?: string;
  syncIndex?: boolean;
};

export type CreateSSEFSkillVersionFromManifestInput = {
  manifest: unknown;
  versionLifecycleState?: SkillLifecycleState;
  skillLifecycleState?: SkillLifecycleState;
  sourceProposalId?: string | null;
  securitySummary?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  actor?: string;
  syncIndex?: boolean;
};

export type CreateSSEFSkillVersionFromManifestResult = {
  skill: SSEFSkill;
  version: SSEFSkillVersion;
};

export type UpdateSSEFSkillLifecycleInput = {
  skillId: string;
  lifecycleState: SkillLifecycleState;
  activeVersion?: string | null;
  latestVersion?: string | null;
  actor?: string;
  reason?: string;
  syncIndex?: boolean;
};

export type SetSSEFSkillActiveVersionInput = {
  skillId: string;
  version: string | null;
  actor?: string;
  reason?: string;
  syncIndex?: boolean;
};

export type UpdateSSEFSkillVersionLifecycleInput = {
  skillVersionId: string;
  lifecycleState: SkillLifecycleState;
  metadata?: Record<string, unknown> | null;
  actor?: string;
  reason?: string;
};

export type CreateSSEFProposalInput = {
  proposalType?: string;
  status?: string;
  skillId?: string;
  requestedBy?: string;
  title?: string;
  summary?: string;
  spark?: Record<string, unknown>;
  constraints?: Record<string, unknown> | null;
  priority?: string;
  metadata?: Record<string, unknown> | null;
  actor?: string;
};

export type UpdateSSEFProposalStatusInput = {
  proposalId: string;
  status: string;
  actor?: string;
  metadata?: Record<string, unknown> | null;
};

export type ListSSEFProposalsOptions = {
  limit?: number;
  offset?: number;
  status?: string;
  proposalType?: string;
  search?: string;
};

export type ListSSEFProposalsResult = {
  items: SSEFProposal[];
  total: number;
  limit: number;
  offset: number;
};

export type ListSSEFRunsOptions = {
  limit?: number;
  offset?: number;
  status?: string;
  runType?: string;
  proposalId?: string;
  skillVersionId?: string;
};

export type ListSSEFRunsResult = {
  items: SSEFRun[];
  total: number;
  limit: number;
  offset: number;
};

export type CreateSSEFRunInput = {
  proposalId?: string | null;
  skillVersionId?: string | null;
  runType: string;
  status: string;
  attempt?: number;
  startedAt?: string;
  metadata?: Record<string, unknown> | null;
  actor?: string;
};

export type UpdateSSEFRunStatusInput = {
  runId: string;
  status: string;
  finishedAt?: string | null;
  stdoutLogPath?: string | null;
  stderrLogPath?: string | null;
  traceLogPath?: string | null;
  error?: string | null;
  result?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  actor?: string;
};

export type RecordSSEFPolicyIncidentInput = {
  runId?: string | null;
  skillVersionId?: string | null;
  severity: string;
  category: string;
  decision?: string;
  message: string;
  details?: Record<string, unknown> | null;
  actor?: string;
};

type SkillVersionIdLookupRow = {
  skill_db_id: string;
  skill_id: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function asRecordOrNull(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  return Object.keys(record).length > 0 ? record : null;
}

function asNonEmptyText(value: string | null | undefined) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asTextOrThrow(value: string | null | undefined, label: string) {
  const normalized = asNonEmptyText(value);
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

function asIsoTimestamp(value: string | undefined | null, label: string) {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${label} must be a valid ISO timestamp.`);
  }
  return parsed.toISOString();
}

function assertRow<T>(row: T | undefined, message: string) {
  if (!row) {
    throw new Error(message);
  }
  return row;
}

function toSafeLimit(value: number | undefined, fallback = 50, max = 200) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(1, Math.floor(parsed)));
}

function toSafeOffset(value: number | undefined) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(0, Math.floor(parsed));
}

function normalizeSkillId(value: string) {
  const skillId = value.trim();
  if (!/^[a-z][a-z0-9._-]{2,63}$/.test(skillId)) {
    throw new Error(
      "skillId must be 3-64 chars and use lowercase letters, digits, dot, underscore, or hyphen."
    );
  }
  return skillId;
}

function normalizeVersion(value: string) {
  const version = value.trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("version must use semver format (example: 1.0.0).");
  }
  return version;
}

function normalizeLifecycleState(
  value: string,
  label = "lifecycleState"
): SkillLifecycleState {
  if (SKILL_LIFECYCLE_STATES.includes(value as SkillLifecycleState)) {
    return value as SkillLifecycleState;
  }
  throw new Error(
    `${label} must be one of: ${SKILL_LIFECYCLE_STATES.join(", ")}.`
  );
}

function normalizeTagValue(
  value: string | null | undefined,
  label: string,
  pattern = /^[a-z][a-z0-9_.:-]{1,127}$/i
) {
  const normalized = asNonEmptyText(value);
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  if (!pattern.test(normalized)) {
    throw new Error(`${label} has an invalid format.`);
  }
  return normalized;
}

function mapSkillRow(row: SSEFSkillRow): SSEFSkill {
  return {
    id: row.id,
    skillId: row.skill_id,
    name: row.name,
    description: row.description,
    lifecycleState: normalizeLifecycleState(row.lifecycle_state, "skill.lifecycle_state"),
    latestVersion: row.latest_version,
    activeVersion: row.active_version,
    metadata: asRecordOrNull(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSkillVersionRow(
  row: SSEFSkillVersionRow,
  skillId: string
): SSEFSkillVersion {
  const manifest = validateSkillManifestV1(asRecord(row.manifest));
  return {
    id: row.id,
    skillDbId: row.skill_id,
    skillId,
    version: row.version,
    lifecycleState: normalizeLifecycleState(
      row.lifecycle_state,
      "version.lifecycle_state"
    ),
    manifest,
    runtime: row.runtime,
    entrypoint: row.entrypoint,
    permissions: manifest.permissions,
    testCases: manifest.test_cases,
    contextKeys: manifest.context_keys,
    dependencies: manifest.dependencies ?? [],
    invocationGraph: manifest.invocation_graph ?? [],
    securitySummary: asRecordOrNull(row.security_summary),
    sourceProposalId: row.source_proposal_id,
    metadata: asRecordOrNull(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapProposalRow(row: SSEFProposalRow): SSEFProposal {
  return {
    id: row.id,
    proposalType: row.proposal_type,
    status: row.status,
    skillDbId: row.skill_id,
    requestedBy: row.requested_by,
    title: row.title,
    summary: row.summary,
    spark: asRecord(row.spark),
    constraints: asRecordOrNull(row.constraints),
    priority: row.priority,
    metadata: asRecordOrNull(row.metadata),
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRunRow(row: SSEFRunRow): SSEFRun {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    skillVersionId: row.skill_version_id,
    runType: row.run_type,
    status: row.status,
    attempt: row.attempt,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    stdoutLogPath: row.stdout_log_path,
    stderrLogPath: row.stderr_log_path,
    traceLogPath: row.trace_log_path,
    error: row.error,
    result: asRecordOrNull(row.result),
    metadata: asRecordOrNull(row.metadata),
    createdAt: row.created_at,
  };
}

function mapPolicyIncidentRow(row: SSEFPolicyIncidentRow): SSEFPolicyIncident {
  return {
    id: row.id,
    runId: row.run_id,
    skillVersionId: row.skill_version_id,
    severity: row.severity,
    category: row.category,
    decision: row.decision,
    message: row.message,
    details: asRecordOrNull(row.details),
    createdAt: row.created_at,
  };
}

function shouldUpdateOptionalField<TKey extends Record<string, unknown>>(
  input: TKey,
  key: keyof TKey
) {
  return (
    Object.prototype.hasOwnProperty.call(input, key) &&
    input[key] !== undefined
  );
}

async function resolveSkillDbId(skillId: string): Promise<string | null> {
  const result = await query<{ id: string }>(
    `
      SELECT id
      FROM ssef_skills
      WHERE skill_id = $1
      LIMIT 1
    `,
    [skillId]
  );
  return result.rows[0]?.id ?? null;
}

async function upsertSkillInternal(input: {
  skillId: string;
  name?: string | null;
  description: string;
  lifecycleState: SkillLifecycleState;
  metadata?: Record<string, unknown> | null;
}) {
  const result = await query<SSEFSkillRow>(
    `
      INSERT INTO ssef_skills (
        id,
        skill_id,
        name,
        description,
        lifecycle_state,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (skill_id)
      DO UPDATE SET
        name = COALESCE(EXCLUDED.name, ssef_skills.name),
        description = EXCLUDED.description,
        lifecycle_state = EXCLUDED.lifecycle_state,
        metadata = COALESCE(EXCLUDED.metadata, ssef_skills.metadata),
        updated_at = NOW()
      RETURNING
        id,
        skill_id,
        name,
        description,
        lifecycle_state,
        latest_version,
        active_version,
        metadata,
        created_at,
        updated_at
    `,
    [
      randomUUID(),
      input.skillId,
      asNonEmptyText(input.name),
      input.description,
      input.lifecycleState,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ]
  );
  return mapSkillRow(assertRow(result.rows[0], "Failed to upsert SSEF skill."));
}

export async function upsertSSEFSkill(
  input: UpsertSSEFSkillInput
): Promise<SSEFSkill> {
  await ensureSchema();
  const skillId = normalizeSkillId(input.skillId);
  const description = asTextOrThrow(input.description, "description");
  const lifecycleState = input.lifecycleState ?? createInitialSkillLifecycleState();
  const skill = await upsertSkillInternal({
    skillId,
    name: input.name,
    description,
    lifecycleState,
    metadata: input.metadata,
  });

  await appendSSEFAuditEvent({
    eventType: "skill.upserted",
    actor: input.actor ?? "ssef-repository",
    skillDbId: skill.id,
    payload: {
      skill_id: skill.skillId,
      lifecycle_state: skill.lifecycleState,
    },
  });

  if (input.syncIndex !== false) {
    await syncSkillsIndexFromRepository({
      actor: input.actor ?? "ssef-repository",
    });
  }

  return skill;
}

export async function getSSEFSkillBySkillId(skillIdInput: string) {
  await ensureSchema();
  const skillId = normalizeSkillId(skillIdInput);
  const result = await query<SSEFSkillRow>(
    `
      SELECT
        id,
        skill_id,
        name,
        description,
        lifecycle_state,
        latest_version,
        active_version,
        metadata,
        created_at,
        updated_at
      FROM ssef_skills
      WHERE skill_id = $1
      LIMIT 1
    `,
    [skillId]
  );
  const row = result.rows[0];
  return row ? mapSkillRow(row) : null;
}

function buildSkillListWhereClause(
  options: Pick<ListSSEFSkillsOptions, "search" | "lifecycleState">
) {
  const params: unknown[] = [];
  const where: string[] = [];
  const search = asNonEmptyText(options.search);
  if (search) {
    params.push(`%${search}%`);
    where.push(
      `(s.skill_id ILIKE $${params.length} OR COALESCE(s.name, '') ILIKE $${params.length} OR s.description ILIKE $${params.length})`
    );
  }

  const rawStates = Array.isArray(options.lifecycleState)
    ? options.lifecycleState
    : options.lifecycleState
      ? [options.lifecycleState]
      : [];
  const states = rawStates
    .map((state) => normalizeLifecycleState(state))
    .filter((value, index, self) => self.indexOf(value) === index);
  if (states.length > 0) {
    params.push(states);
    where.push(`s.lifecycle_state = ANY($${params.length}::text[])`);
  }

  return {
    whereClause: where.length > 0 ? `WHERE ${where.join(" AND ")}` : "",
    params,
  };
}

export async function listSSEFSkills(
  options: ListSSEFSkillsOptions = {}
): Promise<ListSSEFSkillsResult> {
  await ensureSchema();
  const limit = toSafeLimit(options.limit, 50, 200);
  const offset = toSafeOffset(options.offset);
  const { whereClause, params } = buildSkillListWhereClause(options);

  const countResult = await query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM ssef_skills s
      ${whereClause}
    `,
    params
  );
  const total = Number(countResult.rows[0]?.count ?? 0);

  const listParams = [...params, limit, offset];
  const limitParamIndex = params.length + 1;
  const offsetParamIndex = params.length + 2;
  const result = await query<SSEFSkillRow>(
    `
      SELECT
        s.id,
        s.skill_id,
        s.name,
        s.description,
        s.lifecycle_state,
        s.latest_version,
        s.active_version,
        s.metadata,
        s.created_at,
        s.updated_at
      FROM ssef_skills s
      ${whereClause}
      ORDER BY s.updated_at DESC, s.skill_id ASC
      LIMIT $${limitParamIndex}
      OFFSET $${offsetParamIndex}
    `,
    listParams
  );

  return {
    items: result.rows.map(mapSkillRow),
    total,
    limit,
    offset,
  };
}

export async function searchSSEFSkills(
  search: string,
  limit = 20
): Promise<SSEFSkill[]> {
  const result = await listSSEFSkills({
    search,
    limit,
    offset: 0,
  });
  return result.items;
}

export async function createSSEFSkillVersionFromManifest(
  input: CreateSSEFSkillVersionFromManifestInput
): Promise<CreateSSEFSkillVersionFromManifestResult> {
  await ensureSchema();
  const manifest = validateSkillManifestV1(input.manifest);
  const versionLifecycleState =
    input.versionLifecycleState ?? createInitialSkillLifecycleState();
  const skillLifecycleState = input.skillLifecycleState ?? versionLifecycleState;

  const skill = await upsertSkillInternal({
    skillId: manifest.id,
    name: manifest.name ?? null,
    description: manifest.description,
    lifecycleState: skillLifecycleState,
    metadata: null,
  });
  await appendSSEFAuditEvent({
    eventType: "skill.upserted",
    actor: input.actor ?? "ssef-repository",
    skillDbId: skill.id,
    payload: {
      skill_id: manifest.id,
      source: "version_upsert",
      lifecycle_state: skillLifecycleState,
    },
  });

  const versionResult = await query<SSEFSkillVersionRow>(
    `
      INSERT INTO ssef_skill_versions (
        id,
        skill_id,
        version,
        lifecycle_state,
        manifest,
        permissions,
        test_cases,
        context_keys,
        runtime,
        entrypoint,
        security_summary,
        source_proposal_id,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (skill_id, version)
      DO UPDATE SET
        lifecycle_state = EXCLUDED.lifecycle_state,
        manifest = EXCLUDED.manifest,
        permissions = EXCLUDED.permissions,
        test_cases = EXCLUDED.test_cases,
        context_keys = EXCLUDED.context_keys,
        runtime = EXCLUDED.runtime,
        entrypoint = EXCLUDED.entrypoint,
        security_summary = COALESCE(EXCLUDED.security_summary, ssef_skill_versions.security_summary),
        source_proposal_id = COALESCE(EXCLUDED.source_proposal_id, ssef_skill_versions.source_proposal_id),
        metadata = COALESCE(EXCLUDED.metadata, ssef_skill_versions.metadata),
        updated_at = NOW()
      RETURNING
        id,
        skill_id,
        version,
        lifecycle_state,
        manifest,
        permissions,
        test_cases,
        context_keys,
        runtime,
        entrypoint,
        security_summary,
        source_proposal_id,
        metadata,
        created_at,
        updated_at
    `,
    [
      randomUUID(),
      skill.id,
      manifest.version,
      versionLifecycleState,
      JSON.stringify(manifest),
      JSON.stringify(manifest.permissions),
      JSON.stringify(manifest.test_cases),
      JSON.stringify(manifest.context_keys),
      manifest.runtime,
      manifest.entrypoint,
      input.securitySummary ? JSON.stringify(input.securitySummary) : null,
      asNonEmptyText(input.sourceProposalId),
      input.metadata ? JSON.stringify(input.metadata) : null,
    ]
  );

  const mappedVersion = mapSkillVersionRow(
    assertRow(versionResult.rows[0], "Failed to upsert SSEF skill version."),
    manifest.id
  );

  const shouldSetActiveVersion = versionLifecycleState === "active";
  const updatedSkillResult = await query<SSEFSkillRow>(
    `
      UPDATE ssef_skills
      SET
        name = COALESCE($2, name),
        description = $3,
        lifecycle_state = $4,
        latest_version = $5,
        active_version =
          CASE
            WHEN $6::boolean = true THEN $5
            ELSE active_version
          END,
        updated_at = NOW()
      WHERE id = $1
      RETURNING
        id,
        skill_id,
        name,
        description,
        lifecycle_state,
        latest_version,
        active_version,
        metadata,
        created_at,
        updated_at
    `,
    [
      skill.id,
      asNonEmptyText(manifest.name),
      manifest.description,
      skillLifecycleState,
      manifest.version,
      shouldSetActiveVersion,
    ]
  );
  const updatedSkill = mapSkillRow(
    assertRow(updatedSkillResult.rows[0], "Failed to update skill metadata.")
  );

  await appendSSEFAuditEvent({
    eventType: "skill.version.upserted",
    actor: input.actor ?? "ssef-repository",
    skillDbId: updatedSkill.id,
    skillVersionId: mappedVersion.id,
    proposalId: asNonEmptyText(input.sourceProposalId),
    payload: {
      skill_id: manifest.id,
      version: manifest.version,
      version_lifecycle_state: versionLifecycleState,
      skill_lifecycle_state: skillLifecycleState,
      runtime: manifest.runtime,
      entrypoint: manifest.entrypoint,
    },
  });

  if (input.syncIndex !== false) {
    await syncSkillsIndexFromRepository({
      actor: input.actor ?? "ssef-repository",
    });
  }

  return {
    skill: updatedSkill,
    version: mappedVersion,
  };
}

export async function listSSEFSkillVersions(
  skillIdInput: string,
  options: ListSSEFSkillVersionsOptions = {}
): Promise<ListSSEFSkillVersionsResult> {
  await ensureSchema();
  const skillId = normalizeSkillId(skillIdInput);
  const limit = toSafeLimit(options.limit, 50, 200);
  const offset = toSafeOffset(options.offset);

  const countResult = await query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM ssef_skill_versions v
      INNER JOIN ssef_skills s ON s.id = v.skill_id
      WHERE s.skill_id = $1
    `,
    [skillId]
  );
  const total = Number(countResult.rows[0]?.count ?? 0);

  const result = await query<SSEFSkillVersionRow>(
    `
      SELECT
        v.id,
        v.skill_id,
        v.version,
        v.lifecycle_state,
        v.manifest,
        v.permissions,
        v.test_cases,
        v.context_keys,
        v.runtime,
        v.entrypoint,
        v.security_summary,
        v.source_proposal_id,
        v.metadata,
        v.created_at,
        v.updated_at
      FROM ssef_skill_versions v
      INNER JOIN ssef_skills s ON s.id = v.skill_id
      WHERE s.skill_id = $1
      ORDER BY v.created_at DESC, v.version DESC
      LIMIT $2
      OFFSET $3
    `,
    [skillId, limit, offset]
  );

  return {
    items: result.rows.map((row) => mapSkillVersionRow(row, skillId)),
    total,
    limit,
    offset,
  };
}

export async function listSSEFActiveSkillVersions(
  options: ListSSEFActiveSkillVersionsOptions = {}
): Promise<ListSSEFActiveSkillVersionsResult> {
  await ensureSchema();
  const limit = toSafeLimit(options.limit, 50, 200);
  const offset = toSafeOffset(options.offset);

  const countResult = await query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM ssef_skill_versions v
      INNER JOIN ssef_skills s ON s.id = v.skill_id
      WHERE s.lifecycle_state = 'active'
        AND s.active_version IS NOT NULL
        AND v.version = s.active_version
    `
  );
  const total = Number(countResult.rows[0]?.count ?? 0);

  const result = await query<SSEFSkillVersionJoinedRow>(
    `
      SELECT
        v.id,
        v.skill_id,
        v.version,
        v.lifecycle_state,
        v.manifest,
        v.permissions,
        v.test_cases,
        v.context_keys,
        v.runtime,
        v.entrypoint,
        v.security_summary,
        v.source_proposal_id,
        v.metadata,
        v.created_at,
        v.updated_at,
        s.skill_id AS skill_id_text
      FROM ssef_skill_versions v
      INNER JOIN ssef_skills s ON s.id = v.skill_id
      WHERE s.lifecycle_state = 'active'
        AND s.active_version IS NOT NULL
        AND v.version = s.active_version
      ORDER BY s.updated_at DESC, s.skill_id ASC
      LIMIT $1
      OFFSET $2
    `,
    [limit, offset]
  );

  return {
    items: result.rows.map((row) => mapSkillVersionRow(row, row.skill_id_text)),
    total,
    limit,
    offset,
  };
}

export async function getSSEFActiveSkillVersionBySkillId(skillIdInput: string) {
  await ensureSchema();
  const skillId = normalizeSkillId(skillIdInput);
  const result = await query<SSEFSkillVersionJoinedRow>(
    `
      SELECT
        v.id,
        v.skill_id,
        v.version,
        v.lifecycle_state,
        v.manifest,
        v.permissions,
        v.test_cases,
        v.context_keys,
        v.runtime,
        v.entrypoint,
        v.security_summary,
        v.source_proposal_id,
        v.metadata,
        v.created_at,
        v.updated_at,
        s.skill_id AS skill_id_text
      FROM ssef_skill_versions v
      INNER JOIN ssef_skills s ON s.id = v.skill_id
      WHERE s.skill_id = $1
        AND s.lifecycle_state = 'active'
        AND s.active_version IS NOT NULL
        AND v.version = s.active_version
      LIMIT 1
    `,
    [skillId]
  );
  const row = result.rows[0];
  return row ? mapSkillVersionRow(row, row.skill_id_text) : null;
}

export async function getSSEFSkillVersionById(skillVersionIdInput: string) {
  await ensureSchema();
  const skillVersionId = asTextOrThrow(skillVersionIdInput, "skillVersionId");
  const result = await query<SSEFSkillVersionJoinedRow>(
    `
      SELECT
        v.id,
        v.skill_id,
        v.version,
        v.lifecycle_state,
        v.manifest,
        v.permissions,
        v.test_cases,
        v.context_keys,
        v.runtime,
        v.entrypoint,
        v.security_summary,
        v.source_proposal_id,
        v.metadata,
        v.created_at,
        v.updated_at,
        s.skill_id AS skill_id_text
      FROM ssef_skill_versions v
      INNER JOIN ssef_skills s ON s.id = v.skill_id
      WHERE v.id = $1
      LIMIT 1
    `,
    [skillVersionId]
  );
  const row = result.rows[0];
  return row ? mapSkillVersionRow(row, row.skill_id_text) : null;
}

export async function getSSEFSkillVersionBySkillAndVersion(
  skillIdInput: string,
  versionInput: string
) {
  await ensureSchema();
  const skillId = normalizeSkillId(skillIdInput);
  const version = normalizeVersion(versionInput);
  const result = await query<SSEFSkillVersionJoinedRow>(
    `
      SELECT
        v.id,
        v.skill_id,
        v.version,
        v.lifecycle_state,
        v.manifest,
        v.permissions,
        v.test_cases,
        v.context_keys,
        v.runtime,
        v.entrypoint,
        v.security_summary,
        v.source_proposal_id,
        v.metadata,
        v.created_at,
        v.updated_at,
        s.skill_id AS skill_id_text
      FROM ssef_skill_versions v
      INNER JOIN ssef_skills s ON s.id = v.skill_id
      WHERE s.skill_id = $1
        AND v.version = $2
      LIMIT 1
    `,
    [skillId, version]
  );
  const row = result.rows[0];
  return row ? mapSkillVersionRow(row, row.skill_id_text) : null;
}

export async function getLatestSSEFSkillVersionBySourceProposal(
  proposalIdInput: string
) {
  await ensureSchema();
  const proposalId = asTextOrThrow(proposalIdInput, "proposalId");
  const result = await query<SSEFSkillVersionJoinedRow>(
    `
      SELECT
        v.id,
        v.skill_id,
        v.version,
        v.lifecycle_state,
        v.manifest,
        v.permissions,
        v.test_cases,
        v.context_keys,
        v.runtime,
        v.entrypoint,
        v.security_summary,
        v.source_proposal_id,
        v.metadata,
        v.created_at,
        v.updated_at,
        s.skill_id AS skill_id_text
      FROM ssef_skill_versions v
      INNER JOIN ssef_skills s ON s.id = v.skill_id
      WHERE v.source_proposal_id = $1
      ORDER BY v.created_at DESC, v.updated_at DESC
      LIMIT 1
    `,
    [proposalId]
  );
  const row = result.rows[0];
  return row ? mapSkillVersionRow(row, row.skill_id_text) : null;
}

export async function updateSSEFSkillVersionLifecycle(
  input: UpdateSSEFSkillVersionLifecycleInput
) {
  await ensureSchema();
  const skillVersionId = asTextOrThrow(input.skillVersionId, "skillVersionId");
  const lifecycleState = normalizeLifecycleState(
    input.lifecycleState,
    "version.lifecycleState"
  );
  const result = await query<SSEFSkillVersionLifecycleUpdateRow>(
    `
      UPDATE ssef_skill_versions v
      SET
        lifecycle_state = $2,
        metadata = COALESCE($3, v.metadata),
        updated_at = NOW()
      FROM ssef_skills s
      WHERE v.id = $1
        AND s.id = v.skill_id
      RETURNING
        v.id,
        v.skill_id,
        v.version,
        v.lifecycle_state,
        v.manifest,
        v.permissions,
        v.test_cases,
        v.context_keys,
        v.runtime,
        v.entrypoint,
        v.security_summary,
        v.source_proposal_id,
        v.metadata,
        v.created_at,
        v.updated_at,
        s.id AS skill_db_id,
        s.skill_id AS skill_id_text
    `,
    [
      skillVersionId,
      lifecycleState,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ]
  );
  const row = assertRow(
    result.rows[0],
    `SSEF skill version not found: ${skillVersionId}.`
  );
  const version = mapSkillVersionRow(row, row.skill_id_text);

  await appendSSEFAuditEvent({
    eventType: "skill.version.lifecycle.updated",
    actor: input.actor ?? "ssef-repository",
    skillDbId: row.skill_db_id,
    skillVersionId: version.id,
    proposalId: version.sourceProposalId,
    payload: {
      skill_id: version.skillId,
      version: version.version,
      lifecycle_state: version.lifecycleState,
      reason: asNonEmptyText(input.reason),
    },
  });

  return version;
}

export async function updateSSEFSkillLifecycle(
  input: UpdateSSEFSkillLifecycleInput
): Promise<SSEFSkill> {
  await ensureSchema();
  const skillId = normalizeSkillId(input.skillId);
  const lifecycleState = normalizeLifecycleState(input.lifecycleState);
  const params: unknown[] = [skillId, lifecycleState];
  const setClauses = [`lifecycle_state = $2`, `updated_at = NOW()`];

  if (shouldUpdateOptionalField(input, "activeVersion")) {
    params.push(input.activeVersion ? normalizeVersion(input.activeVersion) : null);
    setClauses.push(`active_version = $${params.length}`);
  }
  if (shouldUpdateOptionalField(input, "latestVersion")) {
    params.push(input.latestVersion ? normalizeVersion(input.latestVersion) : null);
    setClauses.push(`latest_version = $${params.length}`);
  }

  const result = await query<SSEFSkillRow>(
    `
      UPDATE ssef_skills
      SET ${setClauses.join(", ")}
      WHERE skill_id = $1
      RETURNING
        id,
        skill_id,
        name,
        description,
        lifecycle_state,
        latest_version,
        active_version,
        metadata,
        created_at,
        updated_at
    `,
    params
  );
  const skill = mapSkillRow(
    assertRow(result.rows[0], `SSEF skill not found: ${skillId}.`)
  );

  await appendSSEFAuditEvent({
    eventType: "skill.lifecycle.updated",
    actor: input.actor ?? "ssef-repository",
    skillDbId: skill.id,
    payload: {
      skill_id: skill.skillId,
      lifecycle_state: skill.lifecycleState,
      active_version: skill.activeVersion,
      latest_version: skill.latestVersion,
      reason: asNonEmptyText(input.reason),
    },
  });

  if (input.syncIndex !== false) {
    await syncSkillsIndexFromRepository({
      actor: input.actor ?? "ssef-repository",
    });
  }

  return skill;
}

export async function setSSEFSkillActiveVersion(
  input: SetSSEFSkillActiveVersionInput
) {
  await ensureSchema();
  const skillId = normalizeSkillId(input.skillId);
  let lifecycleState: SkillLifecycleState = "disabled";
  let activeVersion: string | null = null;

  if (input.version) {
    const version = normalizeVersion(input.version);
    const lookup = await query<SkillVersionIdLookupRow>(
      `
        SELECT
          v.id,
          s.id AS skill_db_id,
          s.skill_id
        FROM ssef_skill_versions v
        INNER JOIN ssef_skills s ON s.id = v.skill_id
        WHERE s.skill_id = $1
          AND v.version = $2
        LIMIT 1
      `,
      [skillId, version]
    );
    assertRow(
      lookup.rows[0],
      `Cannot activate missing version '${version}' for skill '${skillId}'.`
    );
    lifecycleState = "active";
    activeVersion = version;
  }

  return updateSSEFSkillLifecycle({
    skillId,
    lifecycleState,
    activeVersion,
    latestVersion: activeVersion ?? undefined,
    actor: input.actor,
    reason: input.reason,
    syncIndex: input.syncIndex,
  });
}

function buildProposalWhereClause(
  options: Pick<ListSSEFProposalsOptions, "status" | "proposalType" | "search">
) {
  const params: unknown[] = [];
  const where: string[] = [];
  const status = asNonEmptyText(options.status);
  if (status) {
    params.push(status);
    where.push(`p.status = $${params.length}`);
  }
  const proposalType = asNonEmptyText(options.proposalType);
  if (proposalType) {
    params.push(proposalType);
    where.push(`p.proposal_type = $${params.length}`);
  }
  const search = asNonEmptyText(options.search);
  if (search) {
    params.push(`%${search}%`);
    where.push(
      `(COALESCE(p.title, '') ILIKE $${params.length} OR COALESCE(p.summary, '') ILIKE $${params.length})`
    );
  }
  return {
    whereClause: where.length > 0 ? `WHERE ${where.join(" AND ")}` : "",
    params,
  };
}

function buildRunWhereClause(
  options: Pick<
    ListSSEFRunsOptions,
    "status" | "runType" | "proposalId" | "skillVersionId"
  >
) {
  const params: unknown[] = [];
  const where: string[] = [];
  const status = asNonEmptyText(options.status);
  if (status) {
    params.push(status);
    where.push(`r.status = $${params.length}`);
  }
  const runType = asNonEmptyText(options.runType);
  if (runType) {
    params.push(runType);
    where.push(`r.run_type = $${params.length}`);
  }
  const proposalId = asNonEmptyText(options.proposalId);
  if (proposalId) {
    params.push(proposalId);
    where.push(`r.proposal_id = $${params.length}`);
  }
  const skillVersionId = asNonEmptyText(options.skillVersionId);
  if (skillVersionId) {
    params.push(skillVersionId);
    where.push(`r.skill_version_id = $${params.length}`);
  }
  return {
    whereClause: where.length > 0 ? `WHERE ${where.join(" AND ")}` : "",
    params,
  };
}

export async function createSSEFProposal(
  input: CreateSSEFProposalInput
): Promise<SSEFProposal> {
  await ensureSchema();
  const normalizedSkillId = input.skillId
    ? normalizeSkillId(input.skillId)
    : null;
  const skillDbId = normalizedSkillId
    ? await resolveSkillDbId(normalizedSkillId)
    : null;
  if (normalizedSkillId && !skillDbId) {
    throw new Error(`Unknown skill: ${normalizedSkillId}`);
  }

  const proposalType = asNonEmptyText(input.proposalType) ?? "spark";
  const status = asNonEmptyText(input.status) ?? "draft";
  const result = await query<SSEFProposalRow>(
    `
      INSERT INTO ssef_proposals (
        id,
        proposal_type,
        status,
        skill_id,
        requested_by,
        title,
        summary,
        spark,
        constraints,
        priority,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING
        id,
        proposal_type,
        status,
        skill_id,
        requested_by,
        title,
        summary,
        spark,
        constraints,
        priority,
        metadata,
        reviewed_at,
        created_at,
        updated_at
    `,
    [
      randomUUID(),
      proposalType,
      status,
      skillDbId,
      asNonEmptyText(input.requestedBy),
      asNonEmptyText(input.title),
      asNonEmptyText(input.summary),
      JSON.stringify(input.spark ?? {}),
      input.constraints ? JSON.stringify(input.constraints) : null,
      asNonEmptyText(input.priority),
      input.metadata ? JSON.stringify(input.metadata) : null,
    ]
  );

  const proposal = mapProposalRow(
    assertRow(result.rows[0], "Failed to create SSEF proposal.")
  );

  await appendSSEFAuditEvent({
    eventType: "proposal.created",
    actor: input.actor ?? "ssef-repository",
    skillDbId: proposal.skillDbId,
    proposalId: proposal.id,
    payload: {
      proposal_type: proposal.proposalType,
      status: proposal.status,
      title: proposal.title,
    },
  });

  return proposal;
}

export async function getSSEFProposalById(proposalIdInput: string) {
  await ensureSchema();
  const proposalId = asTextOrThrow(proposalIdInput, "proposalId");
  const result = await query<SSEFProposalRow>(
    `
      SELECT
        id,
        proposal_type,
        status,
        skill_id,
        requested_by,
        title,
        summary,
        spark,
        constraints,
        priority,
        metadata,
        reviewed_at,
        created_at,
        updated_at
      FROM ssef_proposals
      WHERE id = $1
      LIMIT 1
    `,
    [proposalId]
  );
  const row = result.rows[0];
  return row ? mapProposalRow(row) : null;
}

export async function updateSSEFProposalStatus(
  input: UpdateSSEFProposalStatusInput
): Promise<SSEFProposal> {
  await ensureSchema();
  const proposalId = asTextOrThrow(input.proposalId, "proposalId");
  const status = asTextOrThrow(input.status, "status");
  const reviewedAt =
    status === "approved" || status === "rejected"
      ? new Date().toISOString()
      : null;
  const result = await query<SSEFProposalRow>(
    `
      UPDATE ssef_proposals
      SET
        status = $2,
        reviewed_at = COALESCE($3, reviewed_at),
        metadata = COALESCE($4, metadata),
        updated_at = NOW()
      WHERE id = $1
      RETURNING
        id,
        proposal_type,
        status,
        skill_id,
        requested_by,
        title,
        summary,
        spark,
        constraints,
        priority,
        metadata,
        reviewed_at,
        created_at,
        updated_at
    `,
    [proposalId, status, reviewedAt, input.metadata ? JSON.stringify(input.metadata) : null]
  );
  const proposal = mapProposalRow(
    assertRow(result.rows[0], `SSEF proposal not found: ${proposalId}.`)
  );

  await appendSSEFAuditEvent({
    eventType: "proposal.status.updated",
    actor: input.actor ?? "ssef-repository",
    skillDbId: proposal.skillDbId,
    proposalId: proposal.id,
    payload: {
      status: proposal.status,
      reviewed_at: proposal.reviewedAt,
    },
  });

  return proposal;
}

export async function listSSEFProposals(
  options: ListSSEFProposalsOptions = {}
): Promise<ListSSEFProposalsResult> {
  await ensureSchema();
  const limit = toSafeLimit(options.limit, 50, 200);
  const offset = toSafeOffset(options.offset);
  const { whereClause, params } = buildProposalWhereClause(options);

  const countResult = await query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM ssef_proposals p
      ${whereClause}
    `,
    params
  );
  const total = Number(countResult.rows[0]?.count ?? 0);

  const listParams = [...params, limit, offset];
  const limitParamIndex = params.length + 1;
  const offsetParamIndex = params.length + 2;
  const result = await query<SSEFProposalRow>(
    `
      SELECT
        p.id,
        p.proposal_type,
        p.status,
        p.skill_id,
        p.requested_by,
        p.title,
        p.summary,
        p.spark,
        p.constraints,
        p.priority,
        p.metadata,
        p.reviewed_at,
        p.created_at,
        p.updated_at
      FROM ssef_proposals p
      ${whereClause}
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT $${limitParamIndex}
      OFFSET $${offsetParamIndex}
    `,
    listParams
  );

  return {
    items: result.rows.map(mapProposalRow),
    total,
    limit,
    offset,
  };
}

export async function createSSEFRun(
  input: CreateSSEFRunInput
): Promise<SSEFRun> {
  await ensureSchema();
  const runType = normalizeTagValue(input.runType, "runType");
  const status = normalizeTagValue(input.status, "status");
  const attempt = Math.max(1, Math.floor(Number(input.attempt ?? 1)));
  const startedAt = asIsoTimestamp(input.startedAt ?? null, "startedAt");

  const result = await query<SSEFRunRow>(
    `
      INSERT INTO ssef_runs (
        id,
        proposal_id,
        skill_version_id,
        run_type,
        status,
        attempt,
        started_at,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, NOW()), $8)
      RETURNING
        id,
        proposal_id,
        skill_version_id,
        run_type,
        status,
        attempt,
        started_at,
        finished_at,
        stdout_log_path,
        stderr_log_path,
        trace_log_path,
        error,
        result,
        metadata,
        created_at
    `,
    [
      randomUUID(),
      asNonEmptyText(input.proposalId),
      asNonEmptyText(input.skillVersionId),
      runType,
      status,
      attempt,
      startedAt,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ]
  );
  const run = mapRunRow(assertRow(result.rows[0], "Failed to create SSEF run."));

  await appendSSEFAuditEvent({
    eventType: "run.created",
    actor: input.actor ?? "ssef-repository",
    skillVersionId: run.skillVersionId,
    proposalId: run.proposalId,
    runId: run.id,
    payload: {
      run_type: run.runType,
      status: run.status,
      attempt: run.attempt,
    },
  });

  return run;
}

export async function getSSEFRunById(runIdInput: string) {
  await ensureSchema();
  const runId = asTextOrThrow(runIdInput, "runId");
  const result = await query<SSEFRunRow>(
    `
      SELECT
        id,
        proposal_id,
        skill_version_id,
        run_type,
        status,
        attempt,
        started_at,
        finished_at,
        stdout_log_path,
        stderr_log_path,
        trace_log_path,
        error,
        result,
        metadata,
        created_at
      FROM ssef_runs
      WHERE id = $1
      LIMIT 1
    `,
    [runId]
  );
  const row = result.rows[0];
  return row ? mapRunRow(row) : null;
}

export async function updateSSEFRunStatus(
  input: UpdateSSEFRunStatusInput
): Promise<SSEFRun> {
  await ensureSchema();
  const runId = asTextOrThrow(input.runId, "runId");
  const status = normalizeTagValue(input.status, "status");
  const finishedAt = asIsoTimestamp(input.finishedAt ?? null, "finishedAt");

  const result = await query<SSEFRunRow>(
    `
      UPDATE ssef_runs
      SET
        status = $2,
        finished_at = COALESCE($3, finished_at),
        stdout_log_path = COALESCE($4, stdout_log_path),
        stderr_log_path = COALESCE($5, stderr_log_path),
        trace_log_path = COALESCE($6, trace_log_path),
        error = COALESCE($7, error),
        result = COALESCE($8, result),
        metadata = COALESCE($9, metadata)
      WHERE id = $1
      RETURNING
        id,
        proposal_id,
        skill_version_id,
        run_type,
        status,
        attempt,
        started_at,
        finished_at,
        stdout_log_path,
        stderr_log_path,
        trace_log_path,
        error,
        result,
        metadata,
        created_at
    `,
    [
      runId,
      status,
      finishedAt,
      asNonEmptyText(input.stdoutLogPath),
      asNonEmptyText(input.stderrLogPath),
      asNonEmptyText(input.traceLogPath),
      asNonEmptyText(input.error),
      input.result ? JSON.stringify(input.result) : null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ]
  );
  const run = mapRunRow(assertRow(result.rows[0], `SSEF run not found: ${runId}.`));

  await appendSSEFAuditEvent({
    eventType: "run.status.updated",
    actor: input.actor ?? "ssef-repository",
    skillVersionId: run.skillVersionId,
    proposalId: run.proposalId,
    runId: run.id,
    payload: {
      status: run.status,
      finished_at: run.finishedAt,
      has_error: Boolean(run.error),
    },
  });

  return run;
}

export async function listSSEFRuns(
  options: ListSSEFRunsOptions = {}
): Promise<ListSSEFRunsResult> {
  await ensureSchema();
  const limit = toSafeLimit(options.limit, 50, 200);
  const offset = toSafeOffset(options.offset);
  const { whereClause, params } = buildRunWhereClause(options);

  const countResult = await query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM ssef_runs r
      ${whereClause}
    `,
    params
  );
  const total = Number(countResult.rows[0]?.count ?? 0);

  const listParams = [...params, limit, offset];
  const limitParamIndex = params.length + 1;
  const offsetParamIndex = params.length + 2;
  const result = await query<SSEFRunRow>(
    `
      SELECT
        r.id,
        r.proposal_id,
        r.skill_version_id,
        r.run_type,
        r.status,
        r.attempt,
        r.started_at,
        r.finished_at,
        r.stdout_log_path,
        r.stderr_log_path,
        r.trace_log_path,
        r.error,
        r.result,
        r.metadata,
        r.created_at
      FROM ssef_runs r
      ${whereClause}
      ORDER BY r.started_at DESC, r.id DESC
      LIMIT $${limitParamIndex}
      OFFSET $${offsetParamIndex}
    `,
    listParams
  );

  return {
    items: result.rows.map(mapRunRow),
    total,
    limit,
    offset,
  };
}

export async function recordSSEFPolicyIncident(
  input: RecordSSEFPolicyIncidentInput
): Promise<SSEFPolicyIncident> {
  await ensureSchema();
  const severity = normalizeTagValue(input.severity, "severity");
  const category = normalizeTagValue(input.category, "category");
  const decision = asNonEmptyText(input.decision) ?? "denied";
  const message = asTextOrThrow(input.message, "message");

  const result = await query<SSEFPolicyIncidentRow>(
    `
      INSERT INTO ssef_policy_incidents (
        id,
        run_id,
        skill_version_id,
        severity,
        category,
        decision,
        message,
        details
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING
        id,
        run_id,
        skill_version_id,
        severity,
        category,
        decision,
        message,
        details,
        created_at
    `,
    [
      randomUUID(),
      asNonEmptyText(input.runId),
      asNonEmptyText(input.skillVersionId),
      severity,
      category,
      decision,
      message,
      input.details ? JSON.stringify(input.details) : null,
    ]
  );
  const incident = mapPolicyIncidentRow(
    assertRow(result.rows[0], "Failed to record SSEF policy incident.")
  );

  let relatedSkillDbId: string | null = null;
  if (incident.skillVersionId) {
    const lookup = await query<SkillVersionIdLookupRow>(
      `
        SELECT
          s.id AS skill_db_id,
          s.skill_id
        FROM ssef_skill_versions v
        INNER JOIN ssef_skills s ON s.id = v.skill_id
        WHERE v.id = $1
        LIMIT 1
      `,
      [incident.skillVersionId]
    );
    relatedSkillDbId = lookup.rows[0]?.skill_db_id ?? null;
  }

  await appendSSEFAuditEvent({
    eventType: "policy.incident.recorded",
    actor: input.actor ?? "ssef-repository",
    skillDbId: relatedSkillDbId,
    skillVersionId: incident.skillVersionId,
    runId: incident.runId,
    payload: {
      severity: incident.severity,
      category: incident.category,
      decision: incident.decision,
      message: incident.message,
    },
  });

  return incident;
}
