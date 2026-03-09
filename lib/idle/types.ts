import { IdleAction } from "../idleActions";

export type IdlePersonaMode = "static" | "dynamic" | "off";
export type IdlePersonaSource = "system_prompt" | "persona_profile" | "mixed";
export type IdleReasoningLevel = "low" | "medium" | "high";

export type IdleConfig = {
  enabled: boolean;
  intervalMs: number;
  sparkIntervalMinMs: number;
  sparkIntervalMaxMs: number;
  cooldownMs: number;
  seedCooldownMs: number;
  burstCount: number;
  modelLite: string;
  modelSmart: string;
  reasoningLevel: IdleReasoningLevel | null;
  topK: number;
  thoughtTtlDays: number | null;
  personaMode: IdlePersonaMode;
  personaSource: IdlePersonaSource;
  salienceStoreThreshold: number;
  salienceEscalateThreshold: number;
  salienceCooldownMs: number;
  personaSemanticThreshold: number;
  personaKeywordBoost: number;
  personaSemanticBoost: number;
  noveltyLowBoost: number;
  noveltyMediumBoost: number;
  noveltyHighBoost: number;
  energyHalfLifeMs: number;
  // Weighted seed sampling
  seedWeightRecencyHalfLifeMs: number;
  seedWeightRecencyFactor: number;
  seedWeightIntensityFactor: number;
  seedWeightFrequencyFactor: number;
  // Associative thought chaining
  chainEnabled: boolean;
  chainMaxDepth: number;
  chainProbability: number;
  // Emotional momentum
  momentumEnabled: boolean;
  momentumDecayRate: number;
  momentumImpact: number;
  // Creativity save (random escape for deferred thoughts)
  creativitySaveRate: number;
};

export type PersonaFocusCache = {
  personaText: string;
  keywords: string[];
  embeddings: number[][];
  updatedAt: number;
};

export type IdleRuntimeState = {
  started: boolean;
  inFlight: boolean;
  lastActivityAt: number;
  lastTickAt: number;
  lastActivitySource: string | null;
  currentEnergy: number;
  lastEnergyAt: number;
  personaFocusCache: PersonaFocusCache | null;
  intervalId: ReturnType<typeof setInterval> | null;
  nextSparkAt: number;
  recentThoughts: string[];
  lastEscalatedBySeed: Record<string, number>;
  lastSeedUsedAt: Record<string, number>;
  seedUseCounts: Record<string, number>;
  lastConsolidationCheck?: number;
  // Emotional momentum: -1 (negative) to +1 (positive)
  emotionalMomentum: number;
  lastMomentumAt: number;
};

export type IdleSeedSource =
  | "main_memory"
  | "personal_memory"
  | "personal_context"
  | "scratchpad"
  | "calendar_event";

export type IdleSeed = {
  id: string;
  source: IdleSeedSource;
  content: string;
  createdAt?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type IdleThought = {
  seedId: string;
  thought: string;
  tas?: {
    temporal?: string;
    valence?: string;
    self_relevance?: string;
    novelty?: "low" | "medium" | "high";
  };
  // Flag for associative thought chaining
  expand?: boolean;
};

export type IdleThoughtReview = {
  editedThought?: string;
  skip?: boolean;
};

export type IdleDecision = "store" | "defer" | "escalate";

export type PersonaMatchType = "keyword" | "semantic" | null;

export type IdleEvaluation = {
  score: number;
  decision: IdleDecision;
  isSimilar: boolean;
  personaMatch: PersonaMatchType;
};

export type IdleActionPlan = {
  editedThought?: string;
  actions: IdleAction[];
  skip?: boolean;
};

export type IdleToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  [key: string]: unknown;
};
