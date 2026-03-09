import modelsData from "@/config/models.json";

export function parseEnvNumber(
  value: string | undefined,
  fallback: number,
  options?: { min?: number; max?: number }
) {
  if (!value || value.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  let normalized = Math.floor(parsed);
  if (typeof options?.min === "number") {
    normalized = Math.max(options.min, normalized);
  }
  if (typeof options?.max === "number") {
    normalized = Math.min(options.max, normalized);
  }
  return normalized;
}

export const embeddingsConfig = modelsData.embeddings;
export const memoryAgentConfig = modelsData.memory_agent;
export const retrievalConfig = (modelsData as { retrieval?: { top_k?: number } })
  .retrieval;

export const DEFAULT_TOP_K = 8;
export const TEMPORAL_WINDOW_MINUTES = 20;
export const TEMPORAL_ANCHOR_LIMIT = 2;
export const TEMPORAL_RESULT_LIMIT = 8;

// Hybrid Search Configuration
export const HYBRID_SEARCH_ENABLED =
  process.env.HYBRID_SEARCH_ENABLED !== "false";
export const HYBRID_RRF_K = parseEnvNumber(
  process.env.HYBRID_RRF_K,
  60,
  { min: 1, max: 100 }
);
export const HYBRID_SEMANTIC_WEIGHT = parseEnvNumber(
  process.env.HYBRID_SEMANTIC_WEIGHT,
  60,
  { min: 0, max: 100 }
) / 100;
export const HYBRID_KEYWORD_WEIGHT = 1 - HYBRID_SEMANTIC_WEIGHT;

// Dynamic TopK Configuration
export const DYNAMIC_TOPK_ENABLED =
  process.env.DYNAMIC_TOPK_ENABLED !== "false";
export const TOPK_BASE = parseEnvNumber(
  process.env.TOPK_BASE,
  6,
  { min: 3, max: 15 }
);
export const TOPK_SPECIFIC_REDUCTION = parseEnvNumber(
  process.env.TOPK_SPECIFIC_REDUCTION,
  2,
  { min: 1, max: 4 }
);
export const TOPK_EXPLORATORY_BOOST = parseEnvNumber(
  process.env.TOPK_EXPLORATORY_BOOST,
  4,
  { min: 1, max: 8 }
);

// Negative Query Filtering Configuration
export const NEGATIVE_FILTERING_ENABLED =
  process.env.NEGATIVE_FILTERING_ENABLED !== "false";
export const NEGATIVE_SIMILARITY_THRESHOLD = 0.25;

// Memory Staleness Decay Configuration
export const STALENESS_DECAY_ENABLED =
  process.env.STALENESS_DECAY_ENABLED !== "false";
export const STALENESS_DECAY_HALF_LIFE_DAYS = parseEnvNumber(
  process.env.STALENESS_DECAY_HALF_LIFE_DAYS,
  30,
  { min: 7, max: 365 }
);
export const STALENESS_CORE_DECAY_FACTOR = 0.5;

// Cross-Collection Query Expansion Configuration
export const CROSS_COLLECTION_EXPANSION_ENABLED =
  process.env.CROSS_COLLECTION_EXPANSION_ENABLED !== "false";
export const CROSS_COLLECTION_MAX_TOPICS = parseEnvNumber(
  process.env.CROSS_COLLECTION_MAX_TOPICS,
  2,
  { min: 1, max: 4 }
);

export const RESONANCE_TAGS = [
  "discovery",
  "curiosity",
  "breakthrough",
  "alignment",
  "attunement",
  "vulnerability",
  "intimacy",
  "reflection",
  "awe",
  "expansion",
  "friction",
  "boundary",
  "uncertainty",
  "quiet",
  "grounded",
  "care",
  "repair",
  "play",
  "delight",
  "flow",
  "focus",
  "commitment",
];
export const RESONANCE_TAG_SET = new Set(RESONANCE_TAGS);
export const RESONANCE_WEIGHT_SET = new Set([
  "core",
  "pivot",
  "notable",
  "transient",
]);

// LLM Re-ranking Configuration
export const RERANK_ENABLED = process.env.RERANK_ENABLED !== "false";
export const RERANK_MODEL =
  process.env.RERANK_MODEL ?? "google/gemini-2.5-flash-lite";
export const RERANK_TOP_N = parseEnvNumber(
  process.env.RERANK_TOP_N,
  8,
  { min: 3, max: 20 }
);
export const RERANK_CANDIDATE_MULTIPLIER = parseEnvNumber(
  process.env.RERANK_CANDIDATE_MULTIPLIER,
  2,
  { min: 1, max: 3 }
);

export const EXCERPT_MEMORY_LIMIT = parseEnvNumber(
  process.env.CONVERSATION_EXCERPT_MEMORY_LIMIT,
  2,
  { min: 0, max: 6 }
);
export const EXCERPT_MESSAGE_LIMIT = parseEnvNumber(
  process.env.CONVERSATION_EXCERPT_MESSAGE_LIMIT,
  12,
  { min: 0, max: 30 }
);
export const EXCERPT_MESSAGE_MAX_CHARS = parseEnvNumber(
  process.env.CONVERSATION_EXCERPT_MESSAGE_MAX_CHARS,
  240,
  { min: 80, max: 1000 }
);
