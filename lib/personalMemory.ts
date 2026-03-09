import modelsData from "@/config/models.json";
import { generateEmbedding } from "./embeddings";
import { queryVectors, upsertVectors, VectorRecord } from "./vector";
import { randomUUID } from "node:crypto";

const embeddingsConfig = modelsData.embeddings;

export const PERSONAL_MEMORY_COLLECTION =
  process.env.CHROMA_PERSONAL_COLLECTION ?? "assistant_personal_memories";
export const PERSONAL_MEMORY_TYPE = "personal";
export const PERSONAL_MEMORY_CATEGORIES = [
  "feeling",
  "experience",
  "thought",
  "view",
  "opinion",
] as const;

export type PersonalMemoryCategory = (typeof PERSONAL_MEMORY_CATEGORIES)[number];

const PERSONAL_MEMORY_SOURCE = "assistant_personal_tool";
const PERSONAL_MEMORY_DEDUP_THRESHOLD = 0.12;
const PERSONAL_MEMORY_CATEGORY_ALIASES: Record<string, PersonalMemoryCategory> = {
  feelings: "feeling",
  emotion: "feeling",
  emotions: "feeling",
  experiences: "experience",
  thoughts: "thought",
  views: "view",
  viewpoint: "view",
  perspective: "view",
  opinions: "opinion",
};
const RESONANCE_WEIGHTS = ["core", "pivot", "notable", "transient"] as const;
const RESONANCE_STATES = [
  "expansive",
  "protective",
  "quiet",
  "focused",
  "playful",
  "tender",
  "analytical",
  "restless",
  "grounded",
] as const;
const RESONANCE_WEIGHT_SET = new Set<string>(RESONANCE_WEIGHTS);
const RESONANCE_STATE_SET = new Set<string>(RESONANCE_STATES);

function normalizeTags(value: unknown): string[] {
  if (!value) {
    return [];
  }
  const tags = Array.isArray(value) ? value : [value];
  const normalized = tags
    .filter((tag) => typeof tag === "string")
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => tag.length > 0);
  return Array.from(new Set(normalized));
}

function normalizeSingleTag(value?: string | null): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized ? normalized : null;
}

function normalizeResonanceWeight(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return RESONANCE_WEIGHT_SET.has(normalized) ? normalized : null;
}

function normalizeResonanceState(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return RESONANCE_STATE_SET.has(normalized) ? normalized : null;
}

function normalizeResonanceIntensity(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  if (!Number.isFinite(parsed)) {
    return null;
  }
  const rounded = Math.round(parsed);
  if (!Number.isFinite(rounded)) {
    return null;
  }
  return Math.min(5, Math.max(1, rounded));
}

function serializeTagList(tags: string[]): string | null {
  if (!Array.isArray(tags) || tags.length === 0) {
    return null;
  }
  return tags.join("|");
}

function normalizeTimestamp(value?: string | null): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
}

export function normalizePersonalMemoryCategory(
  input?: string | null
): PersonalMemoryCategory | null {
  if (typeof input !== "string") {
    return null;
  }
  const normalized = input.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (PERSONAL_MEMORY_CATEGORIES.includes(normalized as PersonalMemoryCategory)) {
    return normalized as PersonalMemoryCategory;
  }
  return PERSONAL_MEMORY_CATEGORY_ALIASES[normalized] ?? null;
}

type SavePersonalMemoryInput = {
  content: string;
  category: string;
  apiKey?: string;
  model?: string;
  conversationId?: string | null;
  sourceAt?: string | null;
  resonanceTags?: string[];
  resonanceWeight?: string | null;
  resonanceIntensity?: number | null;
  resonanceState?: string | null;
  resonanceMotifs?: string[];
  resonancePrimary?: string | null;
  metadata?: Record<string, string | number | boolean | null>;
};

export async function savePersonalMemory({
  content,
  category,
  apiKey,
  model,
  conversationId,
  sourceAt,
  resonanceTags,
  resonanceWeight,
  resonanceIntensity,
  resonanceState,
  resonanceMotifs,
  resonancePrimary,
  metadata,
}: SavePersonalMemoryInput) {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error("Personal memory content is required.");
  }

  const normalizedCategory = normalizePersonalMemoryCategory(category);
  if (!normalizedCategory) {
    throw new Error(
      "Personal memory category is required (feeling, experience, thought, view, opinion)."
    );
  }

  const embeddingModel =
    embeddingsConfig?.model ?? "google/gemini-embedding-001";
  const embedding = await generateEmbedding(trimmed, embeddingModel, apiKey);
  if (embedding.length === 0) {
    throw new Error("Unable to embed personal memory.");
  }

  let distance: number | null = null;
  let isDuplicate = false;
  let existingId: string | null = null;

  try {
    const existing = await queryVectors(
      embedding,
      1,
      PERSONAL_MEMORY_COLLECTION
    );
    const existingDoc = existing.documents?.[0];
    const topDistance = existing.distances?.[0];
    const topId = existing.ids?.[0];
    if (typeof topId === "string") {
      existingId = topId;
    }
    if (
      typeof existingDoc === "string" &&
      existingDoc.trim().toLowerCase() === trimmed.toLowerCase()
    ) {
      isDuplicate = true;
    } else if (typeof topDistance === "number") {
      distance = topDistance;
      if (topDistance < PERSONAL_MEMORY_DEDUP_THRESHOLD) {
        isDuplicate = true;
      }
    }
  } catch (error) {
    console.warn("Personal memory deduplication failed.", error);
  }

  if (isDuplicate) {
    return { status: "skipped", reason: "duplicate", distance, id: existingId };
  }

  const createdAt = new Date().toISOString();
  const normalizedResonanceTags = normalizeTags(resonanceTags);
  const normalizedMotifs = normalizeTags(resonanceMotifs);
  const normalizedPrimary =
    normalizeSingleTag(resonancePrimary) ?? normalizedResonanceTags[0] ?? null;
  const resonanceTagsFlat = serializeTagList(normalizedResonanceTags);
  const resonanceMotifsFlat = serializeTagList(normalizedMotifs);
  const normalizedWeight = normalizeResonanceWeight(resonanceWeight);
  const normalizedState = normalizeResonanceState(resonanceState);
  const normalizedIntensity = normalizeResonanceIntensity(resonanceIntensity);
  const sourceAtValue = normalizeTimestamp(sourceAt) ?? createdAt;
  const safeConversationId =
    typeof conversationId === "string" && conversationId.trim().length > 0
      ? conversationId.trim()
      : null;

  const baseMetadata: Record<string, string | number | boolean | null> = {
    source: PERSONAL_MEMORY_SOURCE,
    created_at: createdAt,
    source_at: sourceAtValue,
    model: model ?? null,
    type: PERSONAL_MEMORY_TYPE,
    category: normalizedCategory,
    conversation_id: safeConversationId,
    resonance_tags_flat: resonanceTagsFlat,
    resonance_motifs_flat: resonanceMotifsFlat,
    resonance_primary: normalizedPrimary,
    resonance_weight: normalizedWeight,
    resonance_intensity: normalizedIntensity,
    resonance_state: normalizedState,
    temporal_window_min: 20,
  };

  const mergedMetadata = {
    ...baseMetadata,
    ...(metadata ?? {}),
  };

  const record: VectorRecord = {
    id: randomUUID(),
    embedding,
    document: trimmed,
    metadata: mergedMetadata,
  };

  await upsertVectors([record], PERSONAL_MEMORY_COLLECTION);

  return { status: "ok", stored: true, id: record.id };
}
