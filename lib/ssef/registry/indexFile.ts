import { ensureSchema, query } from "@/lib/db";
import { validateSkillManifestV1 } from "../contracts/manifest";
import {
  buildSSEFSkillEmbeddingId,
  syncSSEFSkillEmbeddings,
} from "../retrieval/embeddings";
import {
  readProtectedSkillsIndex,
  writeProtectedSkillsIndex,
} from "./protectedAssets";

type SkillsIndexMirrorRow = {
  skill_id: string;
  name: string | null;
  description: string;
  lifecycle_state: string;
  latest_version: string | null;
  active_version: string | null;
  active_runtime: string | null;
  active_entrypoint: string | null;
  active_permissions: unknown;
  active_manifest: unknown;
  updated_at: string;
};

export type SSEFSkillsIndexMirrorRecord = {
  id: string;
  name: string;
  description: string;
  lifecycle_state: string;
  latest_version: string | null;
  active_version: string | null;
  active_runtime: string | null;
  active_entrypoint: string | null;
  active_permissions_count: number;
  dependencies: string[];
  invocation_graph: Array<Record<string, unknown>>;
  embedding_vector_id: string;
  updated_at: string;
};

export type ListSkillsForIndexMirrorOptions = {
  onlyActive?: boolean;
};

export type SyncSkillsIndexFromRepositoryOptions =
  ListSkillsForIndexMirrorOptions & {
    actor?: string;
    allowUnsafeOverwrite?: boolean;
  };

function asArrayLength(value: unknown) {
  if (!value) {
    return 0;
  }
  if (Array.isArray(value)) {
    return value.length;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.length : 0;
    } catch {
      return 0;
    }
  }
  return 0;
}

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

function mapMirrorRow(row: SkillsIndexMirrorRow): SSEFSkillsIndexMirrorRecord {
  let dependencies: string[] = [];
  let invocationGraph: Array<Record<string, unknown>> = [];

  if (row.active_manifest) {
    try {
      const manifest = validateSkillManifestV1(asRecord(row.active_manifest));
      dependencies = manifest.dependencies ?? [];
      invocationGraph = (manifest.invocation_graph ?? []).map((step) => ({
        step: step.step,
        skill_id: step.skill_id,
        description: step.description ?? null,
      }));
    } catch {
      dependencies = [];
      invocationGraph = [];
    }
  }

  return {
    id: row.skill_id,
    name: row.name?.trim() || row.skill_id,
    description: row.description,
    lifecycle_state: row.lifecycle_state,
    latest_version: row.latest_version,
    active_version: row.active_version,
    active_runtime: row.active_runtime,
    active_entrypoint: row.active_entrypoint,
    active_permissions_count: asArrayLength(row.active_permissions),
    dependencies,
    invocation_graph: invocationGraph,
    embedding_vector_id: buildSSEFSkillEmbeddingId(
      row.skill_id,
      row.active_version
    ),
    updated_at: row.updated_at,
  };
}

export async function listSkillsForIndexMirror(
  options: ListSkillsForIndexMirrorOptions = {}
): Promise<SSEFSkillsIndexMirrorRecord[]> {
  await ensureSchema();
  const onlyActive = options.onlyActive === true;
  const whereClause = onlyActive ? "WHERE s.lifecycle_state = 'active'" : "";
  const result = await query<SkillsIndexMirrorRow>(
    `
      SELECT
        s.skill_id,
        s.name,
        s.description,
        s.lifecycle_state,
        s.latest_version,
        s.active_version,
        av.runtime AS active_runtime,
        av.entrypoint AS active_entrypoint,
        av.permissions AS active_permissions,
        av.manifest AS active_manifest,
        s.updated_at
      FROM ssef_skills s
      LEFT JOIN ssef_skill_versions av
        ON av.skill_id = s.id
       AND s.active_version IS NOT NULL
       AND av.version = s.active_version
      ${whereClause}
      ORDER BY s.updated_at DESC, s.skill_id ASC
    `
  );

  return result.rows.map(mapMirrorRow);
}

export async function syncSkillsIndexFromRepository(
  options: SyncSkillsIndexFromRepositoryOptions = {}
) {
  const skills = await listSkillsForIndexMirror({
    onlyActive: options.onlyActive,
  });
  const writeResult = await writeProtectedSkillsIndex(
    {
      version: 1,
      skills: skills as Array<Record<string, unknown>>,
    },
    {
      actor: options.actor ?? "ssef-repository",
      allowUnsafeOverwrite: options.allowUnsafeOverwrite,
    }
  );
  let embeddingSync:
    | Awaited<ReturnType<typeof syncSSEFSkillEmbeddings>>
    | null = null;
  let embeddingSyncError: string | null = null;
  try {
    embeddingSync = await syncSSEFSkillEmbeddings(skills);
  } catch (error) {
    embeddingSyncError =
      error instanceof Error ? error.message : "Unknown embedding sync failure.";
    console.warn("Failed to sync SSEF skill embeddings.", embeddingSyncError);
  }
  return {
    ...writeResult,
    embeddingSync,
    embeddingSyncError,
    skillCount: skills.length,
    skills,
  };
}

export async function readSkillsIndexMirrorSnapshot() {
  return readProtectedSkillsIndex();
}
