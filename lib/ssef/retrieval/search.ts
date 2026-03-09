import { generateEmbedding } from "@/lib/embeddings";
import { keywordSearchVectors, queryVectors } from "@/lib/vector";
import {
  getSSEFSkillEmbeddingCollectionName,
} from "./embeddings";

const DEFAULT_TOP_K = 5;
const STRONG_REUSE_THRESHOLD = 0.74;
const COMPOSITION_THRESHOLD = 0.56;
const COMPOSITION_MIN_SKILLS = 2;

type CandidateSource = "semantic" | "keyword" | "hybrid";

export type SSEFReuseCandidate = {
  skillId: string;
  description: string;
  score: number;
  source: CandidateSource;
  lifecycleState: string;
  latestVersion: string | null;
  activeVersion: string | null;
  dependencyCount: number;
  hasInvocationGraph: boolean;
  semanticDistance: number | null;
};

export type SearchSSEFReuseCandidatesInput = {
  query: string;
  topK?: number;
  onlyActive?: boolean;
  collectionName?: string;
  embeddingModel?: string;
  apiKey?: string;
};

export type SSEFReuseRecommendation =
  | {
      strategy: "reuse_existing";
      reason: string;
      candidates: SSEFReuseCandidate[];
      primarySkillId: string;
      dependencies: string[];
      invocationGraph: Array<{
        step: string;
        skill_id: string;
      }>;
    }
  | {
      strategy: "compose_existing";
      reason: string;
      candidates: SSEFReuseCandidate[];
      dependencies: string[];
      invocationGraph: Array<{
        step: string;
        skill_id: string;
      }>;
    }
  | {
      strategy: "forge_new";
      reason: string;
      candidates: SSEFReuseCandidate[];
      dependencies: string[];
      invocationGraph: Array<{
        step: string;
        skill_id: string;
      }>;
    };

type CandidateAccumulator = {
  id: string;
  description: string;
  lifecycleState: string;
  latestVersion: string | null;
  activeVersion: string | null;
  dependencyCount: number;
  hasInvocationGraph: boolean;
  semanticDistance: number | null;
  semanticRank: number | null;
  keywordRank: number | null;
};

function asNonEmptyText(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function toSafeTopK(value: number | undefined) {
  const parsed = Number(value ?? DEFAULT_TOP_K);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_TOP_K;
  }
  return Math.max(1, Math.min(20, Math.floor(parsed)));
}

function semanticSimilarity(distance: number | null) {
  if (distance === null || !Number.isFinite(distance)) {
    return 0;
  }
  return 1 / (1 + Math.max(0, distance));
}

function rankSignal(rank: number | null) {
  if (!rank || rank <= 0) {
    return 0;
  }
  return 1 / (rank + 1);
}

function buildCandidate(
  seed: CandidateAccumulator,
  hasSemantic: boolean,
  hasKeyword: boolean
): SSEFReuseCandidate {
  const semantic = semanticSimilarity(seed.semanticDistance);
  const semanticRankSignal = rankSignal(seed.semanticRank);
  const keywordRankSignal = rankSignal(seed.keywordRank);
  const combined = Math.min(
    1,
    semantic * 0.55 + semanticRankSignal * 0.25 + keywordRankSignal * 0.2
  );
  return {
    skillId: seed.id,
    description: seed.description,
    score: Number(combined.toFixed(4)),
    source: hasSemantic && hasKeyword ? "hybrid" : hasSemantic ? "semantic" : "keyword",
    lifecycleState: seed.lifecycleState,
    latestVersion: seed.latestVersion,
    activeVersion: seed.activeVersion,
    dependencyCount: seed.dependencyCount,
    hasInvocationGraph: seed.hasInvocationGraph,
    semanticDistance: seed.semanticDistance,
  };
}

function toMetadataRecord(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function buildSSEFReuseQueryFromSpark(
  spark: Record<string, unknown>
): string {
  const values: string[] = [];
  const maybePush = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach((entry) => maybePush(entry));
      return;
    }
    const text = asNonEmptyText(value);
    if (text) {
      values.push(text);
    }
  };

  maybePush(spark.problem ?? spark.need ?? spark.issue);
  maybePush(
    spark.desired_outcome ??
      spark.desiredOutcome ??
      spark.outcome ??
      spark.goal
  );
  maybePush(
    spark.skill_name ??
      spark.skillName ??
      spark.preferred_skill_name ??
      spark.preferredSkillName
  );
  maybePush(spark.inputs ?? spark.input ?? spark.input_examples);
  maybePush(spark.constraints ?? spark.constraint ?? spark.guardrails);
  maybePush(spark.keywords);
  return values.join(" ").trim();
}

export async function searchSSEFReuseCandidates(
  input: SearchSSEFReuseCandidatesInput
): Promise<SSEFReuseCandidate[]> {
  const query = input.query.trim();
  if (!query) {
    return [];
  }

  const topK = toSafeTopK(input.topK);
  const collectionName = input.collectionName ?? getSSEFSkillEmbeddingCollectionName();
  const where = input.onlyActive === false ? undefined : { lifecycle_state: "active" };
  const embeddingModel =
    input.embeddingModel ?? process.env.SSEF_SKILL_EMBEDDINGS_MODEL ?? "google/gemini-embedding-001";
  const embedding = await generateEmbedding(query, embeddingModel, input.apiKey);
  if (!embedding || embedding.length === 0) {
    return [];
  }

  const [semantic, keyword] = await Promise.all([
    queryVectors(embedding, topK * 2, collectionName, where),
    keywordSearchVectors(query, topK * 2, collectionName, where),
  ]);

  const pool = new Map<string, CandidateAccumulator>();
  semantic.ids.forEach((vectorId, index) => {
    const metadata = toMetadataRecord(semantic.metadatas[index]);
    const skillId = asNonEmptyText(metadata.skill_id) ?? vectorId;
    const existing = pool.get(skillId) ?? {
      id: skillId,
      description: "",
      lifecycleState: asNonEmptyText(metadata.lifecycle_state) ?? "unknown",
      latestVersion: asNonEmptyText(metadata.latest_version),
      activeVersion: asNonEmptyText(metadata.active_version),
      dependencyCount: asNumber(metadata.dependency_count) ?? 0,
      hasInvocationGraph: Boolean(metadata.has_invocation_graph),
      semanticDistance: null,
      semanticRank: null,
      keywordRank: null,
    };
    const semanticDoc = semantic.documents[index];
    if (!existing.description && typeof semanticDoc === "string") {
      existing.description = semanticDoc;
    }
    existing.semanticDistance = semantic.distances[index] ?? null;
    existing.semanticRank = index + 1;
    pool.set(skillId, existing);
  });

  keyword.ids.forEach((vectorId, index) => {
    const metadata = toMetadataRecord(keyword.metadatas[index]);
    const skillId = asNonEmptyText(metadata.skill_id) ?? vectorId;
    const existing = pool.get(skillId) ?? {
      id: skillId,
      description: "",
      lifecycleState: asNonEmptyText(metadata.lifecycle_state) ?? "unknown",
      latestVersion: asNonEmptyText(metadata.latest_version),
      activeVersion: asNonEmptyText(metadata.active_version),
      dependencyCount: asNumber(metadata.dependency_count) ?? 0,
      hasInvocationGraph: Boolean(metadata.has_invocation_graph),
      semanticDistance: null,
      semanticRank: null,
      keywordRank: null,
    };
    const keywordDoc = keyword.documents[index];
    if (!existing.description && typeof keywordDoc === "string") {
      existing.description = keywordDoc;
    }
    existing.keywordRank = index + 1;
    pool.set(skillId, existing);
  });

  const candidates = Array.from(pool.values())
    .map((entry) =>
      buildCandidate(
        entry,
        typeof entry.semanticRank === "number",
        typeof entry.keywordRank === "number"
      )
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return candidates;
}

export async function recommendSSEFReuseStrategy(
  input: SearchSSEFReuseCandidatesInput
): Promise<SSEFReuseRecommendation> {
  const candidates = await searchSSEFReuseCandidates(input);
  const strong = candidates[0];
  if (strong && strong.score >= STRONG_REUSE_THRESHOLD) {
    return {
      strategy: "reuse_existing",
      reason: `Found strong reuse match '${strong.skillId}' (score=${strong.score}).`,
      candidates,
      primarySkillId: strong.skillId,
      dependencies: [strong.skillId],
      invocationGraph: [
        {
          step: "step_1",
          skill_id: strong.skillId,
        },
      ],
    };
  }

  const compositionCandidates = candidates.filter(
    (candidate) => candidate.score >= COMPOSITION_THRESHOLD
  );
  if (compositionCandidates.length >= COMPOSITION_MIN_SKILLS) {
    const selected = compositionCandidates.slice(0, 3);
    return {
      strategy: "compose_existing",
      reason:
        "Multiple reusable skills meet composition threshold; prefer composing active skills.",
      candidates,
      dependencies: selected.map((candidate) => candidate.skillId),
      invocationGraph: selected.map((candidate, index) => ({
        step: `step_${String(index + 1)}`,
        skill_id: candidate.skillId,
      })),
    };
  }

  return {
    strategy: "forge_new",
    reason: "No strong reuse/composition candidate exceeded threshold.",
    candidates,
    dependencies: compositionCandidates
      .slice(0, 3)
      .map((candidate) => candidate.skillId),
    invocationGraph: compositionCandidates.slice(0, 3).map((candidate, index) => ({
      step: `step_${String(index + 1)}`,
      skill_id: candidate.skillId,
    })),
  };
}
