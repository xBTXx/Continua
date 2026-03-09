import { createChatCompletion } from "../openrouter";
import { generateEmbedding } from "../embeddings";
import { keywordSearchVectors, queryVectors } from "../vector";
import {
  PERSONAL_MEMORY_COLLECTION,
  normalizePersonalMemoryCategory,
} from "../personalMemory";
import {
  DEFAULT_TOP_K,
  embeddingsConfig,
  HYBRID_KEYWORD_WEIGHT,
  HYBRID_RRF_K,
  HYBRID_SEARCH_ENABLED,
  HYBRID_SEMANTIC_WEIGHT,
  memoryAgentConfig,
  NEGATIVE_FILTERING_ENABLED,
  NEGATIVE_SIMILARITY_THRESHOLD,
  RERANK_CANDIDATE_MULTIPLIER,
  RERANK_ENABLED,
  RERANK_MODEL,
  RERANK_TOP_N,
  retrievalConfig,
  STALENESS_DECAY_ENABLED,
} from "./config";
import {
  buildMemorySnippet,
  truncateText,
} from "./helpers";
import { applyStalenesDecay, sortByFreshness } from "./ranking";
import type {
  MemoryFilters,
  MemoryRetrievalOptions,
  MemorySnippet,
  PersonalMemoryRetrievalOptions,
} from "./types";

/**
 * Hybrid Search Result combining semantic and keyword search.
 * Uses Reciprocal Rank Fusion (RRF) to merge rankings.
 */
type HybridSearchResult = {
  id: string;
  document: string;
  metadata: Record<string, unknown> | null;
  semanticRank?: number;
  keywordRank?: number;
  rrfScore: number;
};

type RerankedMemory = MemorySnippet & {
  rerankScore?: number;
};

type FilterPlan = {
  where?: Record<string, unknown>;
  requiresClientFiltering: boolean;
  matchesMetadata: (metadata: Record<string, unknown> | null) => boolean;
};

const CLIENT_FILTER_OVERFETCH_MULTIPLIER = 4;
const CLIENT_FILTER_OVERFETCH_BUFFER = 8;

function normalizeFilterValue(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function normalizeBoundaryDate(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
}

function buildFilterPlan(filters?: MemoryFilters): FilterPlan {
  const type = normalizeFilterValue(filters?.type);
  const category = normalizeFilterValue(filters?.category);
  const resonancePrimary = normalizeFilterValue(filters?.resonancePrimary);
  const resonanceWeight = normalizeFilterValue(filters?.resonanceWeight);
  const start = normalizeBoundaryDate(filters?.start);
  const end = normalizeBoundaryDate(filters?.end);

  const scalarConstraints: Array<[string, string]> = [];
  if (type) {
    scalarConstraints.push(["type", type]);
  }
  if (category) {
    scalarConstraints.push(["category", category]);
  }
  if (resonancePrimary) {
    scalarConstraints.push(["resonance_primary", resonancePrimary]);
  }
  if (resonanceWeight) {
    scalarConstraints.push(["resonance_weight", resonanceWeight]);
  }

  const where =
    scalarConstraints.length > 0
      ? { [scalarConstraints[0][0]]: scalarConstraints[0][1] }
      : undefined;
  const requiresClientFiltering =
    scalarConstraints.length > 1 || Boolean(start || end);

  return {
    where,
    requiresClientFiltering,
    matchesMetadata: (metadata) => {
      if (!filters || Object.keys(filters).length === 0) {
        return true;
      }
      const safeMetadata = metadata ?? {};

      for (const [field, expected] of scalarConstraints) {
        const actual = normalizeFilterValue(safeMetadata[field]);
        if (actual !== expected) {
          return false;
        }
      }

      if (start || end) {
        const createdAt = normalizeBoundaryDate(safeMetadata.created_at);
        if (!createdAt) {
          return false;
        }
        if (start && createdAt < start) {
          return false;
        }
        if (end && createdAt > end) {
          return false;
        }
      }

      return true;
    },
  };
}

/**
 * Reciprocal Rank Fusion (RRF) algorithm for combining search rankings.
 * Formula: RRF(d) = Σ (weight / (k + rank(d)))
 * where k is a constant (default 60) that controls emphasis on top ranks.
 */
function computeRRFScore(
  semanticRank: number | undefined,
  keywordRank: number | undefined,
  k: number = HYBRID_RRF_K
): number {
  let score = 0;
  if (typeof semanticRank === "number") {
    score += HYBRID_SEMANTIC_WEIGHT / (k + semanticRank);
  }
  if (typeof keywordRank === "number") {
    score += HYBRID_KEYWORD_WEIGHT / (k + keywordRank);
  }
  return score;
}

/**
 * Hybrid search combining semantic (vector) and keyword search.
 * Returns results ranked by Reciprocal Rank Fusion score.
 */
async function hybridSearchMemories(
  queryText: string,
  embedding: number[],
  topK: number,
  collectionName?: string,
  where?: Record<string, unknown>
): Promise<HybridSearchResult[]> {
  // Run both searches in parallel
  const [semanticResults, keywordResults] = await Promise.all([
    queryVectors(embedding, topK * 2, collectionName, where),
    keywordSearchVectors(queryText, topK * 2, collectionName, where),
  ]);

  // Build a map of all results with their rankings
  const resultMap = new Map<string, HybridSearchResult>();

  // Add semantic results with their rankings
  semanticResults.ids.forEach((id, index) => {
    const doc = semanticResults.documents[index];
    if (typeof doc !== "string" || doc.trim().length === 0) {
      return;
    }
    resultMap.set(id, {
      id,
      document: doc,
      metadata: semanticResults.metadatas[index] ?? null,
      semanticRank: index + 1,
      rrfScore: 0,
    });
  });

  // Add keyword results, merging with existing semantic results
  keywordResults.ids.forEach((id, index) => {
    const doc = keywordResults.documents[index];
    if (typeof doc !== "string" || doc.trim().length === 0) {
      return;
    }
    const existing = resultMap.get(id);
    if (existing) {
      existing.keywordRank = index + 1;
    } else {
      resultMap.set(id, {
        id,
        document: doc,
        metadata: keywordResults.metadatas[index] ?? null,
        keywordRank: index + 1,
        rrfScore: 0,
      });
    }
  });

  // Compute RRF scores
  for (const result of resultMap.values()) {
    result.rrfScore = computeRRFScore(result.semanticRank, result.keywordRank);
  }

  // Sort by RRF score (higher is better) and take topK
  return Array.from(resultMap.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, topK);
}

/**
 * Compute cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

/**
 * Filter out memories that match negative queries.
 * Uses embedding similarity to identify memories matching exclusion criteria.
 */
async function filterByNegativeQueries(
  memories: MemorySnippet[],
  negativeQueries: string[],
  embeddingModel: string,
  apiKey?: string
): Promise<MemorySnippet[]> {
  if (!NEGATIVE_FILTERING_ENABLED || negativeQueries.length === 0) {
    return memories;
  }

  // Generate embeddings for negative queries
  const negativeEmbeddings: number[][] = [];
  for (const negQuery of negativeQueries.slice(0, 2)) {
    const embedding = await generateEmbedding(negQuery, embeddingModel, apiKey);
    if (embedding.length > 0) {
      negativeEmbeddings.push(embedding);
    }
  }

  if (negativeEmbeddings.length === 0) {
    return memories;
  }

  // Filter out memories that are too similar to negative queries
  const filtered: MemorySnippet[] = [];
  for (const memory of memories) {
    // Generate embedding for memory content
    const memoryEmbedding = await generateEmbedding(
      memory.content.slice(0, 500),
      embeddingModel,
      apiKey
    );

    if (memoryEmbedding.length === 0) {
      filtered.push(memory);
      continue;
    }

    // Check similarity against all negative embeddings
    let shouldExclude = false;
    for (const negEmbedding of negativeEmbeddings) {
      const similarity = cosineSimilarity(memoryEmbedding, negEmbedding);
      if (similarity > (1 - NEGATIVE_SIMILARITY_THRESHOLD)) {
        shouldExclude = true;
        break;
      }
    }

    if (!shouldExclude) {
      filtered.push(memory);
    }
  }

  return filtered;
}

/**
 * LLM-based re-ranking of memory results.
 * Uses a lightweight model to score each memory's relevance to the query.
 */
async function rerankMemories(
  query: string,
  memories: MemorySnippet[],
  topN: number = RERANK_TOP_N,
  apiKey?: string,
  appUrl?: string
): Promise<RerankedMemory[]> {
  if (memories.length === 0) {
    return [];
  }

  if (memories.length <= topN) {
    return memories;
  }

  const memoryList = memories
    .map((m, i) => `[${i}] ${truncateText(m.content, 200)}`)
    .join("\n");

  const prompt = `You are a relevance scoring assistant. Rate each memory's relevance to the query on a scale of 0-10.

Query: "${truncateText(query, 300)}"

Memories:
${memoryList}

For each memory, consider:
- Direct relevance to the query topic
- Specificity (more specific = higher score if relevant)
- Recency signals if time is mentioned
- Contradiction or superseding info (should rank higher if more current)

Return ONLY a JSON object with scores:
{"scores": [{"index": 0, "score": 8}, {"index": 1, "score": 5}, ...]}`;

  try {
    const response = await createChatCompletion({
      model: RERANK_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      stream: false,
      apiKey,
      appUrl,
    });

    if (!response.ok) {
      console.warn("Re-ranking LLM call failed, using original order.");
      return memories.slice(0, topN);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content?.trim() ?? "";

    const jsonStart = content.indexOf("{");
    const jsonEnd = content.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd === -1) {
      console.warn("Re-ranking: Invalid JSON response, using original order.");
      return memories.slice(0, topN);
    }

    const parsed = JSON.parse(content.slice(jsonStart, jsonEnd + 1));
    const scores = parsed.scores;

    if (!Array.isArray(scores)) {
      console.warn("Re-ranking: No scores array, using original order.");
      return memories.slice(0, topN);
    }

    const scoreMap = new Map<number, number>();
    for (const entry of scores) {
      if (
        typeof entry === "object" &&
        typeof entry.index === "number" &&
        typeof entry.score === "number"
      ) {
        scoreMap.set(entry.index, entry.score);
      }
    }

    const reranked: RerankedMemory[] = memories.map((memory, index) => ({
      ...memory,
      rerankScore: scoreMap.get(index) ?? 0,
    }));

    reranked.sort((a, b) => (b.rerankScore ?? 0) - (a.rerankScore ?? 0));

    return reranked.slice(0, topN);
  } catch (error) {
    console.warn("Re-ranking failed:", error);
    return memories.slice(0, topN);
  }
}

async function retrieveMemoriesFromCollection(
  query: string,
  apiKey?: string,
  options?: MemoryRetrievalOptions
): Promise<MemorySnippet[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }

  const embeddingModel =
    embeddingsConfig?.model ?? "google/gemini-embedding-001";
  const baseTopK =
    options?.topK ??
    retrievalConfig?.top_k ??
    memoryAgentConfig?.candidate_count ??
    DEFAULT_TOP_K;
  const topK = RERANK_ENABLED ? baseTopK * RERANK_CANDIDATE_MULTIPLIER : baseTopK;

  const embedding = await generateEmbedding(trimmed, embeddingModel, apiKey);
  if (embedding.length === 0) {
    return [];
  }
  const filterPlan = buildFilterPlan(options?.filters);
  const requestedTopK = filterPlan.requiresClientFiltering
    ? Math.max(
        topK * CLIENT_FILTER_OVERFETCH_MULTIPLIER,
        topK + CLIENT_FILTER_OVERFETCH_BUFFER
      )
    : topK;

  const memories: MemorySnippet[] = [];

  if (HYBRID_SEARCH_ENABLED) {
    const hybridResults = await hybridSearchMemories(
      trimmed,
      embedding,
      requestedTopK,
      options?.collectionName,
      filterPlan.where
    );

    for (const result of hybridResults) {
      if (!filterPlan.matchesMetadata(result.metadata)) {
        continue;
      }
      memories.push(
        buildMemorySnippet(
          result.document,
          result.metadata as Record<string, unknown> | null,
          result.id
        )
      );
    }
  } else {
    const results = await queryVectors(
      embedding,
      requestedTopK,
      options?.collectionName,
      filterPlan.where
    );

    results.documents.forEach((doc, index) => {
      if (typeof doc !== "string" || doc.trim().length === 0) {
        return;
      }
      const metadata = results.metadatas[index] ?? {};
      if (!filterPlan.matchesMetadata(metadata)) {
        return;
      }
      const memoryId = results.ids?.[index];
      memories.push(buildMemorySnippet(doc, metadata ?? {}, memoryId));
    });
  }

  const deduped = new Map<string, MemorySnippet>();
  for (const memory of memories) {
    const memoryId = memory.id?.trim();
    const key = memoryId
      ? `id:${memoryId}`
      : `content:${memory.content.toLowerCase()}`;
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, memory);
      continue;
    }
    if (memory.createdAt && existing.createdAt) {
      if (memory.createdAt > existing.createdAt) {
        deduped.set(key, memory);
      }
    } else if (memory.createdAt && !existing.createdAt) {
      deduped.set(key, memory);
    }
  }

  const dedupedArray = Array.from(deduped.values());
  let results: MemorySnippet[];

  if (STALENESS_DECAY_ENABLED) {
    const withFreshness = applyStalenesDecay(dedupedArray);
    results = sortByFreshness(withFreshness);
  } else {
    results = dedupedArray.sort((a, b) => {
      if (a.createdAt && b.createdAt) {
        return b.createdAt.localeCompare(a.createdAt);
      }
      if (a.createdAt) {
        return -1;
      }
      if (b.createdAt) {
        return 1;
      }
      return 0;
    });
  }

  if (options?.negativeQueries && options.negativeQueries.length > 0) {
    results = await filterByNegativeQueries(
      results,
      options.negativeQueries,
      embeddingModel,
      apiKey
    );
  }

  if (RERANK_ENABLED && results.length > RERANK_TOP_N) {
    results = await rerankMemories(
      query,
      results,
      options?.topK ?? RERANK_TOP_N,
      apiKey
    );
  }

  return results;
}

export async function retrieveMemories(
  query: string,
  apiKey?: string,
  filters?: MemoryFilters
): Promise<MemorySnippet[]> {
  return retrieveMemoriesFromCollection(query, apiKey, { filters });
}

export async function retrievePersonalMemories(
  query: string,
  apiKey?: string,
  options?: PersonalMemoryRetrievalOptions
): Promise<MemorySnippet[]> {
  const topK = options?.topK ?? 5;
  const category = normalizePersonalMemoryCategory(options?.category);
  const filters: MemoryFilters = {};
  if (category) {
    filters.category = category;
  }
  if (options?.resonancePrimary) {
    filters.resonancePrimary = options.resonancePrimary;
  }
  if (options?.resonanceWeight) {
    filters.resonanceWeight = options.resonanceWeight;
  }
  const effectiveFilters =
    Object.keys(filters).length > 0 ? filters : undefined;
  return retrieveMemoriesFromCollection(query, apiKey, {
    topK,
    collectionName: PERSONAL_MEMORY_COLLECTION,
    filters: effectiveFilters,
  });
}
