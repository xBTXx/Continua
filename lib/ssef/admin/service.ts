import fs from "node:fs/promises";
import path from "node:path";
import { ensureSchema, query } from "@/lib/db";
import { appendSSEFAuditEvent } from "../audit";
import { ensureSSEFReady } from "../bootstrap";
import { getSSEFConfig } from "../config";
import { syncSkillsIndexFromRepository } from "../registry/indexFile";
import { ensureProtectedAssetsReady } from "../registry/protectedAssets";

const CHROMA_URL = process.env.CHROMA_URL ?? "http://vector:8000";
const CHROMA_TENANT = process.env.CHROMA_TENANT ?? "default";
const CHROMA_DATABASE = process.env.CHROMA_DATABASE ?? "default";
const DEFAULT_EMBEDDING_COLLECTION =
  process.env.SSEF_SKILL_EMBEDDINGS_COLLECTION?.trim() || "ssef_skills_index";

type IdRow = {
  id: string;
};

type SkillLookupRow = {
  id: string;
  skill_id: string;
};

type DeleteSSEFProposalInput = {
  proposalId: string;
  actor?: string;
  reason?: string;
};

export type DeleteSSEFProposalResult = {
  proposalId: string;
  deleted: boolean;
  deletedRuns: number;
  deletedRunArtifacts: number;
  deletedAuditEvents: number;
  deletedPolicyIncidents: number;
};

type DeleteSSEFSkillInput = {
  skillId: string;
  actor?: string;
  reason?: string;
  deleteLinkedProposals?: boolean;
};

export type DeleteSSEFSkillResult = {
  skillId: string;
  deleted: boolean;
  deletedVersions: number;
  deletedRuns: number;
  deletedLinkedProposals: number;
  deletedVaultArtifacts: boolean;
  deletedForgeArtifacts: number;
  deletedAuditEvents: number;
  deletedPolicyIncidents: number;
};

type ResetSSEFStateInput = {
  actor?: string;
  reason?: string;
};

export type ResetSSEFStateResult = {
  deletedRows: {
    policyIncidents: number;
    auditEvents: number;
    runs: number;
    versions: number;
    proposals: number;
    skills: number;
  };
  workspaceRootDeleted: boolean;
  embeddingCollectionDeleted: boolean;
  bootstrapReady: boolean;
};

function asNonEmptyText(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asActor(value: unknown, fallback: string) {
  return asNonEmptyText(value) ?? fallback;
}

function assertUuid(value: unknown, label: string) {
  const text = asNonEmptyText(value);
  if (!text) {
    throw new Error(`${label} is required.`);
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      text
    )
  ) {
    throw new Error(`${label} must be a UUID.`);
  }
  return text;
}

function assertSkillId(value: unknown) {
  const text = asNonEmptyText(value);
  if (!text) {
    throw new Error("skillId is required.");
  }
  if (!/^[a-z][a-z0-9._-]{2,63}$/.test(text)) {
    throw new Error(
      "skillId must be 3-64 chars and use lowercase letters, digits, dot, underscore, or hyphen."
    );
  }
  return text;
}

async function deleteRowsByIds(params: {
  ids: string[];
  table: string;
  column?: string;
}) {
  if (params.ids.length === 0) {
    return 0;
  }
  const column = params.column ?? "id";
  const result = await query<IdRow>(
    `
      DELETE FROM ${params.table}
      WHERE ${column} = ANY($1::uuid[])
      RETURNING id
    `,
    [params.ids]
  );
  return result.rowCount ?? result.rows.length;
}

async function deleteForgeRunArtifactDirs(runIds: string[]) {
  if (runIds.length === 0) {
    return 0;
  }
  const config = getSSEFConfig();
  let deleted = 0;
  for (const runId of runIds) {
    const jobDir = path.join(config.forgeDir, "jobs", runId);
    try {
      await fs.rm(jobDir, { recursive: true, force: true });
      deleted += 1;
    } catch {
      // Ignore best-effort artifact cleanup errors.
    }
  }
  return deleted;
}

async function listRunIdsForProposal(proposalId: string) {
  const result = await query<IdRow>(
    `
      SELECT id
      FROM ssef_runs
      WHERE proposal_id = $1
    `,
    [proposalId]
  );
  return result.rows.map((row) => row.id);
}

async function listVersionIdsForSkillDbId(skillDbId: string) {
  const result = await query<IdRow>(
    `
      SELECT id
      FROM ssef_skill_versions
      WHERE skill_id = $1
    `,
    [skillDbId]
  );
  return result.rows.map((row) => row.id);
}

async function listProposalIdsForSkillDbId(skillDbId: string) {
  const result = await query<IdRow>(
    `
      SELECT id
      FROM ssef_proposals
      WHERE skill_id = $1
    `,
    [skillDbId]
  );
  return result.rows.map((row) => row.id);
}

async function listRunIdsForSkillCleanup(params: {
  versionIds: string[];
  proposalIds: string[];
}) {
  if (params.versionIds.length === 0 && params.proposalIds.length === 0) {
    return [];
  }
  const result = await query<IdRow>(
    `
      SELECT id
      FROM ssef_runs
      WHERE
        (array_length($1::uuid[], 1) IS NOT NULL AND skill_version_id = ANY($1::uuid[]))
        OR
        (array_length($2::uuid[], 1) IS NOT NULL AND proposal_id = ANY($2::uuid[]))
    `,
    [params.versionIds, params.proposalIds]
  );
  return result.rows.map((row) => row.id);
}

async function removeSSEFEmbeddingCollection() {
  const listUrl = `${CHROMA_URL}/api/v2/tenants/${CHROMA_TENANT}/databases/${CHROMA_DATABASE}/collections`;
  const listResponse = await fetch(listUrl);
  if (!listResponse.ok) {
    throw new Error(
      `Unable to list embedding collections (${listResponse.status}).`
    );
  }
  const collections = (await listResponse.json()) as Array<{
    id?: string;
    name?: string;
  }>;
  const match = collections.find(
    (collection) => collection.name === DEFAULT_EMBEDDING_COLLECTION
  );
  if (!match?.id) {
    return false;
  }
  const deleteResponse = await fetch(`${listUrl}/${match.id}`, {
    method: "DELETE",
  });
  if (!deleteResponse.ok && deleteResponse.status !== 404) {
    throw new Error(
      `Unable to delete embedding collection (${deleteResponse.status}).`
    );
  }
  return true;
}

export async function deleteSSEFProposalCascade(
  input: DeleteSSEFProposalInput
): Promise<DeleteSSEFProposalResult> {
  await ensureSchema();
  const proposalId = assertUuid(input.proposalId, "proposalId");
  const actor = asActor(input.actor, "ssef-admin");
  const reason = asNonEmptyText(input.reason) ?? "Proposal deleted via SSEF console.";

  const existing = await query<IdRow>(
    `
      SELECT id
      FROM ssef_proposals
      WHERE id = $1
      LIMIT 1
    `,
    [proposalId]
  );
  if (!existing.rows[0]) {
    throw new Error(`SSEF proposal not found: ${proposalId}`);
  }

  const runIds = await listRunIdsForProposal(proposalId);
  const deletedPolicyIncidents = await deleteRowsByIds({
    ids: runIds,
    table: "ssef_policy_incidents",
    column: "run_id",
  });
  const deletedRunAuditEvents = await deleteRowsByIds({
    ids: runIds,
    table: "ssef_audit_events",
    column: "run_id",
  });
  const deletedRuns = await deleteRowsByIds({
    ids: runIds,
    table: "ssef_runs",
  });
  const deletedRunArtifacts = await deleteForgeRunArtifactDirs(runIds);

  const proposalAuditEvents = await query<IdRow>(
    `
      DELETE FROM ssef_audit_events
      WHERE proposal_id = $1
      RETURNING id
    `,
    [proposalId]
  );
  const deletedProposalRows = await query<IdRow>(
    `
      DELETE FROM ssef_proposals
      WHERE id = $1
      RETURNING id
    `,
    [proposalId]
  );

  await appendSSEFAuditEvent({
    eventType: "proposal.deleted",
    actor,
    payload: {
      proposal_id: proposalId,
      reason,
      deleted_runs: deletedRuns,
      deleted_run_artifacts: deletedRunArtifacts,
      deleted_audit_events: (proposalAuditEvents.rowCount ?? proposalAuditEvents.rows.length) + deletedRunAuditEvents,
      deleted_policy_incidents: deletedPolicyIncidents,
    },
  });

  return {
    proposalId,
    deleted: (deletedProposalRows.rowCount ?? deletedProposalRows.rows.length) > 0,
    deletedRuns,
    deletedRunArtifacts,
    deletedAuditEvents:
      (proposalAuditEvents.rowCount ?? proposalAuditEvents.rows.length) +
      deletedRunAuditEvents,
    deletedPolicyIncidents,
  };
}

export async function deleteSSEFSkillCascade(
  input: DeleteSSEFSkillInput
): Promise<DeleteSSEFSkillResult> {
  await ensureSchema();
  const skillId = assertSkillId(input.skillId);
  const actor = asActor(input.actor, "ssef-admin");
  const reason = asNonEmptyText(input.reason) ?? "Skill deleted via SSEF console.";
  const deleteLinkedProposals = input.deleteLinkedProposals !== false;

  const skillLookup = await query<SkillLookupRow>(
    `
      SELECT id, skill_id
      FROM ssef_skills
      WHERE skill_id = $1
      LIMIT 1
    `,
    [skillId]
  );
  const skill = skillLookup.rows[0];
  if (!skill) {
    throw new Error(`SSEF skill not found: ${skillId}`);
  }

  const versionIds = await listVersionIdsForSkillDbId(skill.id);
  const proposalIds = deleteLinkedProposals
    ? await listProposalIdsForSkillDbId(skill.id)
    : [];
  const runIds = await listRunIdsForSkillCleanup({
    versionIds,
    proposalIds,
  });

  const deletedPolicyIncidents = await deleteRowsByIds({
    ids: runIds,
    table: "ssef_policy_incidents",
    column: "run_id",
  });
  const deletedRunAuditEvents = await deleteRowsByIds({
    ids: runIds,
    table: "ssef_audit_events",
    column: "run_id",
  });
  const deletedRuns = await deleteRowsByIds({
    ids: runIds,
    table: "ssef_runs",
  });
  const deletedForgeArtifacts = await deleteForgeRunArtifactDirs(runIds);

  let deletedLinkedProposals = 0;
  let deletedProposalAuditEvents = 0;
  if (proposalIds.length > 0) {
    const proposalAuditEvents = await deleteRowsByIds({
      ids: proposalIds,
      table: "ssef_audit_events",
      column: "proposal_id",
    });
    const deletedProposals = await deleteRowsByIds({
      ids: proposalIds,
      table: "ssef_proposals",
    });
    deletedLinkedProposals = deletedProposals;
    deletedProposalAuditEvents = proposalAuditEvents;
  }

  const deletedVersionAuditEvents = await deleteRowsByIds({
    ids: versionIds,
    table: "ssef_audit_events",
    column: "skill_version_id",
  });
  const deletedSkillAuditRows = await query<IdRow>(
    `
      DELETE FROM ssef_audit_events
      WHERE skill_id = $1
      RETURNING id
    `,
    [skill.id]
  );

  const deletedVersions = await deleteRowsByIds({
    ids: versionIds,
    table: "ssef_skill_versions",
  });
  const deletedSkillRows = await query<IdRow>(
    `
      DELETE FROM ssef_skills
      WHERE id = $1
      RETURNING id
    `,
    [skill.id]
  );

  const config = getSSEFConfig();
  const vaultSkillDir = path.join(config.vaultDir, skillId);
  let deletedVaultArtifacts = false;
  try {
    await fs.rm(vaultSkillDir, { recursive: true, force: true });
    deletedVaultArtifacts = true;
  } catch {
    deletedVaultArtifacts = false;
  }

  await syncSkillsIndexFromRepository({
    actor,
  });

  await appendSSEFAuditEvent({
    eventType: "skill.deleted",
    actor,
    payload: {
      skill_id: skillId,
      reason,
      delete_linked_proposals: deleteLinkedProposals,
      deleted_versions: deletedVersions,
      deleted_runs: deletedRuns,
      deleted_linked_proposals: deletedLinkedProposals,
      deleted_vault_artifacts: deletedVaultArtifacts,
      deleted_forge_artifacts: deletedForgeArtifacts,
      deleted_policy_incidents: deletedPolicyIncidents,
    },
  });

  return {
    skillId,
    deleted: (deletedSkillRows.rowCount ?? deletedSkillRows.rows.length) > 0,
    deletedVersions,
    deletedRuns,
    deletedLinkedProposals,
    deletedVaultArtifacts,
    deletedForgeArtifacts,
    deletedAuditEvents:
      deletedRunAuditEvents +
      deletedProposalAuditEvents +
      deletedVersionAuditEvents +
      (deletedSkillAuditRows.rowCount ?? deletedSkillAuditRows.rows.length),
    deletedPolicyIncidents,
  };
}

export async function resetSSEFState(
  input: ResetSSEFStateInput = {}
): Promise<ResetSSEFStateResult> {
  await ensureSchema();
  const actor = asActor(input.actor, "ssef-admin");
  const reason =
    asNonEmptyText(input.reason) ?? "Full SSEF reset triggered from SSEF console.";

  const deletedPolicyIncidents = await query<IdRow>(
    `
      DELETE FROM ssef_policy_incidents
      RETURNING id
    `
  );
  const deletedAuditEvents = await query<IdRow>(
    `
      DELETE FROM ssef_audit_events
      RETURNING id
    `
  );
  const deletedRuns = await query<IdRow>(
    `
      DELETE FROM ssef_runs
      RETURNING id
    `
  );
  const deletedVersions = await query<IdRow>(
    `
      DELETE FROM ssef_skill_versions
      RETURNING id
    `
  );
  const deletedProposals = await query<IdRow>(
    `
      DELETE FROM ssef_proposals
      RETURNING id
    `
  );
  const deletedSkills = await query<IdRow>(
    `
      DELETE FROM ssef_skills
      RETURNING id
    `
  );

  const config = getSSEFConfig();
  let workspaceRootDeleted = false;
  try {
    await fs.rm(config.rootDir, { recursive: true, force: true });
    workspaceRootDeleted = true;
  } catch {
    workspaceRootDeleted = false;
  }

  let embeddingCollectionDeleted = false;
  try {
    embeddingCollectionDeleted = await removeSSEFEmbeddingCollection();
  } catch {
    embeddingCollectionDeleted = false;
  }

  const bootstrap = await ensureSSEFReady();
  await ensureProtectedAssetsReady();
  await syncSkillsIndexFromRepository({
    actor,
  });

  await appendSSEFAuditEvent({
    eventType: "ssef.reset",
    actor,
    payload: {
      reason,
      deleted_rows: {
        policy_incidents: deletedPolicyIncidents.rowCount ?? deletedPolicyIncidents.rows.length,
        audit_events: deletedAuditEvents.rowCount ?? deletedAuditEvents.rows.length,
        runs: deletedRuns.rowCount ?? deletedRuns.rows.length,
        versions: deletedVersions.rowCount ?? deletedVersions.rows.length,
        proposals: deletedProposals.rowCount ?? deletedProposals.rows.length,
        skills: deletedSkills.rowCount ?? deletedSkills.rows.length,
      },
      workspace_root_deleted: workspaceRootDeleted,
      embedding_collection_deleted: embeddingCollectionDeleted,
      bootstrap_ready: bootstrap.ready,
    },
  });

  return {
    deletedRows: {
      policyIncidents:
        deletedPolicyIncidents.rowCount ?? deletedPolicyIncidents.rows.length,
      auditEvents: deletedAuditEvents.rowCount ?? deletedAuditEvents.rows.length,
      runs: deletedRuns.rowCount ?? deletedRuns.rows.length,
      versions: deletedVersions.rowCount ?? deletedVersions.rows.length,
      proposals: deletedProposals.rowCount ?? deletedProposals.rows.length,
      skills: deletedSkills.rowCount ?? deletedSkills.rows.length,
    },
    workspaceRootDeleted,
    embeddingCollectionDeleted,
    bootstrapReady: bootstrap.ready,
  };
}
