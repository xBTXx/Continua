import { generateEmbedding } from "@/lib/embeddings";
import {
  deleteVectors,
  listVectors,
  upsertVectors,
  type VectorRecord,
} from "@/lib/vector";

const DEFAULT_COLLECTION_NAME =
  process.env.SSEF_SKILL_EMBEDDINGS_COLLECTION?.trim() || "ssef_skills_index";
const DEFAULT_EMBEDDING_MODEL =
  process.env.SSEF_SKILL_EMBEDDINGS_MODEL?.trim() ||
  "google/gemini-embedding-001";
const EMBEDDING_NAMESPACE = "ssef_skill_description_v1";

const MAX_DOCUMENT_LENGTH = 2_000;
const VECTOR_PAGE_SIZE = 300;

export type SSEFSkillEmbeddingSource = {
  id: string;
  name: string;
  description: string;
  lifecycle_state: string;
  latest_version: string | null;
  active_version: string | null;
  dependencies?: string[];
  invocation_graph?: Array<Record<string, unknown>>;
};

export type UpsertSSEFSkillEmbeddingsOptions = {
  collectionName?: string;
  embeddingModel?: string;
  apiKey?: string;
};

export type SyncSSEFSkillEmbeddingsResult = {
  collectionName: string;
  embeddingModel: string;
  upserted: number;
  removed: number;
  skipped: number;
};

function clipText(value: string, maxLength = MAX_DOCUMENT_LENGTH) {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return normalized.slice(0, maxLength - 3).trimEnd() + "...";
}

function asListSummary(values: string[] | undefined) {
  if (!values || values.length === 0) {
    return "none";
  }
  return values.slice(0, 20).join(", ");
}

function toEmbeddingMetadata(record: SSEFSkillEmbeddingSource) {
  return {
    namespace: EMBEDDING_NAMESPACE,
    skill_id: record.id,
    lifecycle_state: record.lifecycle_state,
    active_version: record.active_version ?? "",
    latest_version: record.latest_version ?? "",
    dependency_count: record.dependencies?.length ?? 0,
    has_invocation_graph: Boolean(
      Array.isArray(record.invocation_graph) && record.invocation_graph.length > 0
    ),
  };
}

function toEmbeddingDocument(record: SSEFSkillEmbeddingSource) {
  return clipText(
    [
      `Skill ID: ${record.id}`,
      `Name: ${record.name}`,
      `Description: ${record.description}`,
      `Lifecycle: ${record.lifecycle_state}`,
      `Latest version: ${record.latest_version ?? "none"}`,
      `Active version: ${record.active_version ?? "none"}`,
      `Dependencies: ${asListSummary(record.dependencies)}`,
    ].join("\n")
  );
}

export function getSSEFSkillEmbeddingCollectionName() {
  return DEFAULT_COLLECTION_NAME;
}

export function getSSEFSkillEmbeddingNamespace() {
  return EMBEDDING_NAMESPACE;
}

export function buildSSEFSkillEmbeddingId(
  skillId: string,
  activeVersion: string | null | undefined
) {
  return `ssef.skill.${skillId}.${activeVersion ?? "none"}`;
}

export async function upsertSSEFSkillEmbeddings(
  records: SSEFSkillEmbeddingSource[],
  options: UpsertSSEFSkillEmbeddingsOptions = {}
) {
  const collectionName = options.collectionName ?? DEFAULT_COLLECTION_NAME;
  const embeddingModel = options.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
  const upserts: VectorRecord[] = [];
  let skipped = 0;

  for (const record of records) {
    const doc = toEmbeddingDocument(record);
    if (!doc) {
      skipped += 1;
      continue;
    }
    const embedding = await generateEmbedding(
      doc,
      embeddingModel,
      options.apiKey
    );
    if (!embedding || embedding.length === 0) {
      skipped += 1;
      continue;
    }

    upserts.push({
      id: buildSSEFSkillEmbeddingId(record.id, record.active_version),
      embedding,
      document: doc,
      metadata: toEmbeddingMetadata(record),
    });
  }

  await upsertVectors(upserts, collectionName);
  return {
    collectionName,
    embeddingModel,
    upserted: upserts.length,
    skipped,
  };
}

async function listSkillEmbeddingIds(collectionName: string) {
  const ids: string[] = [];
  let offset = 0;
  while (true) {
    const page = await listVectors(
      VECTOR_PAGE_SIZE,
      offset,
      collectionName,
      {
        namespace: EMBEDDING_NAMESPACE,
      }
    );
    if (page.ids.length === 0) {
      break;
    }
    ids.push(...page.ids);
    offset += page.ids.length;
    if (page.ids.length < VECTOR_PAGE_SIZE) {
      break;
    }
  }
  return ids;
}

export async function syncSSEFSkillEmbeddings(
  records: SSEFSkillEmbeddingSource[],
  options: UpsertSSEFSkillEmbeddingsOptions = {}
): Promise<SyncSSEFSkillEmbeddingsResult> {
  const upsertResult = await upsertSSEFSkillEmbeddings(records, options);
  const expectedIds = new Set(
    records.map((record) =>
      buildSSEFSkillEmbeddingId(record.id, record.active_version)
    )
  );
  const existingIds = await listSkillEmbeddingIds(upsertResult.collectionName);
  const staleIds = existingIds.filter((id) => !expectedIds.has(id));
  if (staleIds.length > 0) {
    await deleteVectors(staleIds, upsertResult.collectionName);
  }

  return {
    collectionName: upsertResult.collectionName,
    embeddingModel: upsertResult.embeddingModel,
    upserted: upsertResult.upserted,
    removed: staleIds.length,
    skipped: upsertResult.skipped,
  };
}
