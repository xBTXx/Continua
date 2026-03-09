import { IdleReasoningLevel, IdlePersonaMode, IdlePersonaSource } from "./types";

export const MAX_SEED_LENGTH = 600;
export const MAX_CONTEXT_MESSAGES = 4;
export const MAX_SEEDS_LIMIT = 16;
export const RECENT_THOUGHT_LIMIT = 12;
export const RECENT_THOUGHT_PROMPT_LIMIT = 6;
export const RECENT_ACTION_LOG_LIMIT = 15;
export const RELATED_THOUGHT_LIMIT = 6;
export const RELATED_THOUGHT_MIN_OVERLAP = 2;
export const MAX_IDLE_TOOL_ROUNDS = 4;
export const ENERGY_MIN = 0.1;
export const ENERGY_MAX = 1;
export const ESCALATE_THRESHOLD_MAX = 0.98;
export const ESCALATE_THRESHOLD_BUFFER = 0.05;
export const PERSONA_SHORT_TOKENS = new Set(["ai", "ml", "ux", "ui", "nlp"]);
export const PERSONA_FASCINATION_PREFIX = "she is fascinated by";
export const PERSONA_FOCUS_PREFIX = "current focus:";
export const PERSONA_MIN_KEYWORD_LENGTH = 4;
export const PERSONA_MIN_SEMANTIC_TOPICS = 2;
export const ACTION_CUE_REGEX =
  /\b(should|need to|remind|follow up|follow-up|reach out|message|email|call|text|plan|schedule|check in|check-in|draft|reply)\b/i;
export const THOUGHT_STOPWORDS = new Set([
  "user",
  "wants",
  "want",
  "wanted",
  "need",
  "needs",
  "needed",
  "should",
  "could",
  "would",
  "maybe",
  "think",
  "thinking",
  "thought",
  "analyze",
  "analysis",
  "review",
  "check",
  "look",
  "idle",
  "state",
  "assistant",
  "about",
  "with",
  "from",
  "this",
  "that",
  "these",
  "those",
  "into",
  "over",
  "after",
  "before",
  "next",
  "last",
]);
export const ALLOWED_IDLE_ACTIONS = new Set([
  "edit_thought",
  "draft_message",
  "draft_email",
  "start_conversation",
  "save_note",
  "schedule_reminder",
]);

export const DEFAULTS = {
  enabled: false,
  intervalMs: 15000,
  sparkIntervalMinMs: 30000,
  sparkIntervalMaxMs: 60000,
  cooldownMs: 300000,
  seedCooldownMs: 30 * 60 * 1000,
  burstCount: 1,
  modelLite: "google/gemini-2.5-flash-lite",
  modelSmart: "google/gemini-3-pro-preview",
  reasoningLevel: "medium" as IdleReasoningLevel,
  topK: 8,
  thoughtTtlDays: null as number | null,
  personaMode: "static" as IdlePersonaMode,
  personaSource: "system_prompt" as IdlePersonaSource,
  salienceStoreThreshold: 0.45,
  salienceEscalateThreshold: 0.8,
  salienceCooldownMs: 6 * 60 * 60 * 1000,
  personaSemanticThreshold: 0.78,
  personaKeywordBoost: 0.25,
  personaSemanticBoost: 0.15,
  noveltyLowBoost: 0.05,
  noveltyMediumBoost: 0.1,
  noveltyHighBoost: 0.2,
  energyHalfLifeMs: 2 * 60 * 60 * 1000,
  // Weighted seed sampling
  seedWeightRecencyHalfLifeMs: 24 * 60 * 60 * 1000, // 24 hours
  seedWeightRecencyFactor: 0.5,
  seedWeightIntensityFactor: 0.3,
  seedWeightFrequencyFactor: 0.2,
  // Associative thought chaining
  chainEnabled: true,
  chainMaxDepth: 2,
  chainProbability: 0.3,
  // Emotional momentum
  momentumEnabled: true,
  momentumDecayRate: 0.1, // Decay per tick
  momentumImpact: 0.15, // Score impact factor
  // Creativity save (random escape for deferred thoughts)
  creativitySaveRate: 0.1, // 10% chance to store a deferred thought
};

export const IDLE_STATE_KEY = "__assistantIdleState";
