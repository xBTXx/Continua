import { getIdleEnabledSetting } from "../idleSettings";
import {
  DEFAULTS,
  ENERGY_MIN,
  ENERGY_MAX,
} from "./constants";
import {
  IdleConfig,
  IdleRuntimeState,
} from "./types";
import {
  parseBoolean,
  parseNumber,
  normalizeEnum,
  clampNumber,
} from "./utils";

function normalizeReasoningLevel(value: string | undefined) {
  const normalized = normalizeEnum(
    value,
    ["low", "medium", "high"] as const,
    DEFAULTS.reasoningLevel
  );
  return normalized ?? null;
}

export function getNextSparkIntervalMs(config: IdleConfig) {
  const min = Math.max(1000, config.sparkIntervalMinMs);
  const max = Math.max(min, config.sparkIntervalMaxMs);
  if (min === max) {
    return min;
  }
  return Math.floor(min + Math.random() * (max - min));
}

export function updateIdleEnergy(state: IdleRuntimeState, config: IdleConfig, nowMs: number) {
  const cooldownEndAt =
    state.lastActivityAt > 0 ? state.lastActivityAt + config.cooldownMs : 0;
  const decayStartAt = Math.max(state.lastEnergyAt, cooldownEndAt);
  if (nowMs <= decayStartAt) {
    state.currentEnergy = clampNumber(state.currentEnergy, ENERGY_MIN, ENERGY_MAX);
    state.lastEnergyAt = nowMs;
    return state.currentEnergy;
  }
  const elapsedMs = nowMs - decayStartAt;
  const halfLifeMs = Math.max(60000, config.energyHalfLifeMs);
  const decayFactor = Math.pow(0.5, elapsedMs / halfLifeMs);
  const decayedEnergy = state.currentEnergy * decayFactor;
  state.currentEnergy = clampNumber(decayedEnergy, ENERGY_MIN, ENERGY_MAX);
  state.lastEnergyAt = nowMs;
  return state.currentEnergy;
}

/**
 * Update emotional momentum based on a thought's valence.
 * Positive valence pushes momentum toward +1, negative toward -1.
 * Momentum decays toward 0 over time.
 * Returns the updated momentum value.
 */
export function updateEmotionalMomentum(
  state: IdleRuntimeState,
  config: IdleConfig,
  valence: "positive" | "negative" | "neutral" | string | undefined,
  nowMs?: number
): number {
  if (!config.momentumEnabled) {
    return state.emotionalMomentum;
  }

  const now = nowMs ?? Date.now();

  // Apply decay based on time elapsed since last update
  const elapsedMs = now - state.lastMomentumAt;
  const ticksElapsed = Math.max(0, elapsedMs / (config.intervalMs || 15000));
  const decayFactor = Math.pow(1 - config.momentumDecayRate, ticksElapsed);
  let momentum = state.emotionalMomentum * decayFactor;

  // Apply valence shift
  const shift = valence === "positive" ? 0.2 : valence === "negative" ? -0.2 : 0;
  momentum = momentum + shift * (1 - Math.abs(momentum)); // Asymptotic approach to ±1

  // Clamp to [-1, 1]
  momentum = Math.max(-1, Math.min(1, momentum));

  state.emotionalMomentum = momentum;
  state.lastMomentumAt = now;

  return momentum;
}

/**
 * Get a scoring adjustment based on current emotional momentum.
 * Positive momentum boosts positive valence thoughts.
 * Negative momentum boosts negative valence thoughts.
 */
export function getMomentumScoreAdjustment(
  momentum: number,
  valence: "positive" | "negative" | "neutral" | string | undefined,
  config: IdleConfig
): number {
  if (!config.momentumEnabled || Math.abs(momentum) < 0.1) {
    return 0;
  }

  // If momentum and valence align, boost the score
  // If they conflict, slightly reduce it
  const isPositive = valence === "positive";
  const isNegative = valence === "negative";

  if (momentum > 0 && isPositive) {
    return config.momentumImpact * momentum;
  }
  if (momentum < 0 && isNegative) {
    return config.momentumImpact * Math.abs(momentum);
  }
  if (momentum > 0 && isNegative) {
    return -config.momentumImpact * momentum * 0.5;
  }
  if (momentum < 0 && isPositive) {
    return -config.momentumImpact * Math.abs(momentum) * 0.5;
  }

  return 0;
}

export async function getIdleConfig(): Promise<IdleConfig> {
  const thoughtTtlRaw = process.env.IDLE_THOUGHT_TTL_DAYS;
  const thoughtTtlParsed = parseNumber(thoughtTtlRaw, 0, { min: 0 });
  const envEnabled = parseBoolean(process.env.IDLE_ENABLED, DEFAULTS.enabled);
  let overrideEnabled: boolean | null = null;
  try {
    overrideEnabled = await getIdleEnabledSetting();
  } catch (error) {
    console.warn("Idle enabled setting load failed.", error);
  }
  const intervalMs = parseNumber(
    process.env.IDLE_INTERVAL_MS,
    DEFAULTS.intervalMs,
    { min: 1000, max: 60 * 60 * 1000 }
  );
  const sparkIntervalMinMs = parseNumber(
    process.env.IDLE_SPARK_INTERVAL_MIN_MS,
    intervalMs,
    { min: 1000, max: 60 * 60 * 1000 }
  );
  const sparkIntervalMaxMs = parseNumber(
    process.env.IDLE_SPARK_INTERVAL_MAX_MS,
    DEFAULTS.sparkIntervalMaxMs,
    { min: sparkIntervalMinMs, max: 24 * 60 * 60 * 1000 }
  );
  const config: IdleConfig = {
    enabled: overrideEnabled ?? envEnabled,
    intervalMs,
    sparkIntervalMinMs,
    sparkIntervalMaxMs,
    cooldownMs: parseNumber(process.env.IDLE_COOLDOWN_MS, DEFAULTS.cooldownMs, {
      min: 0,
      max: 24 * 60 * 60 * 1000,
    }),
    seedCooldownMs: parseNumber(
      process.env.IDLE_SEED_COOLDOWN_MS,
      DEFAULTS.seedCooldownMs,
      { min: 0, max: 24 * 60 * 60 * 1000 }
    ),
    burstCount: Math.round(
      parseNumber(process.env.IDLE_BURST_COUNT, DEFAULTS.burstCount, {
        min: 1,
        max: 60,
      })
    ),
    modelLite: process.env.IDLE_MODEL_LITE?.trim() || DEFAULTS.modelLite,
    modelSmart: process.env.IDLE_MODEL_SMART?.trim() || DEFAULTS.modelSmart,
    reasoningLevel: normalizeReasoningLevel(process.env.IDLE_REASONING_LEVEL),
    topK: Math.round(
      parseNumber(process.env.IDLE_TOP_K, DEFAULTS.topK, { min: 1, max: 50 })
    ),
    thoughtTtlDays: thoughtTtlParsed > 0 ? thoughtTtlParsed : null,
    personaMode: normalizeEnum(
      process.env.IDLE_PERSONA_MODE,
      ["static", "dynamic", "off"] as const,
      DEFAULTS.personaMode
    ),
    personaSource: normalizeEnum(
      process.env.IDLE_PERSONA_SOURCE,
      ["system_prompt", "persona_profile", "mixed"] as const,
      DEFAULTS.personaSource
    ),
    salienceStoreThreshold: parseNumber(
      process.env.IDLE_SALIENCE_STORE_THRESHOLD,
      DEFAULTS.salienceStoreThreshold,
      { min: 0, max: 1 }
    ),
    salienceEscalateThreshold: parseNumber(
      process.env.IDLE_SALIENCE_ESCALATE_THRESHOLD,
      DEFAULTS.salienceEscalateThreshold,
      { min: 0, max: 1 }
    ),
    salienceCooldownMs: parseNumber(
      process.env.IDLE_SALIENCE_COOLDOWN_MS,
      DEFAULTS.salienceCooldownMs,
      { min: 0, max: 7 * 24 * 60 * 60 * 1000 }
    ),
    personaSemanticThreshold: parseNumber(
      process.env.IDLE_PERSONA_SEMANTIC_THRESHOLD,
      DEFAULTS.personaSemanticThreshold,
      { min: 0, max: 1 }
    ),
    personaKeywordBoost: parseNumber(
      process.env.IDLE_PERSONA_KEYWORD_BOOST,
      DEFAULTS.personaKeywordBoost,
      { min: 0, max: 1 }
    ),
    personaSemanticBoost: parseNumber(
      process.env.IDLE_PERSONA_SEMANTIC_BOOST,
      DEFAULTS.personaSemanticBoost,
      { min: 0, max: 1 }
    ),
    noveltyLowBoost: parseNumber(
      process.env.IDLE_NOVELTY_LOW_BOOST,
      DEFAULTS.noveltyLowBoost,
      { min: 0, max: 1 }
    ),
    noveltyMediumBoost: parseNumber(
      process.env.IDLE_NOVELTY_MEDIUM_BOOST,
      DEFAULTS.noveltyMediumBoost,
      { min: 0, max: 1 }
    ),
    noveltyHighBoost: parseNumber(
      process.env.IDLE_NOVELTY_HIGH_BOOST,
      DEFAULTS.noveltyHighBoost,
      { min: 0, max: 1 }
    ),
    energyHalfLifeMs: parseNumber(
      process.env.IDLE_ENERGY_HALF_LIFE_MS,
      DEFAULTS.energyHalfLifeMs,
      { min: 60000, max: 24 * 60 * 60 * 1000 }
    ),
    // Weighted seed sampling
    seedWeightRecencyHalfLifeMs: parseNumber(
      process.env.IDLE_SEED_WEIGHT_RECENCY_HALF_LIFE_MS,
      DEFAULTS.seedWeightRecencyHalfLifeMs,
      { min: 60000, max: 7 * 24 * 60 * 60 * 1000 }
    ),
    seedWeightRecencyFactor: parseNumber(
      process.env.IDLE_SEED_WEIGHT_RECENCY_FACTOR,
      DEFAULTS.seedWeightRecencyFactor,
      { min: 0, max: 1 }
    ),
    seedWeightIntensityFactor: parseNumber(
      process.env.IDLE_SEED_WEIGHT_INTENSITY_FACTOR,
      DEFAULTS.seedWeightIntensityFactor,
      { min: 0, max: 1 }
    ),
    seedWeightFrequencyFactor: parseNumber(
      process.env.IDLE_SEED_WEIGHT_FREQUENCY_FACTOR,
      DEFAULTS.seedWeightFrequencyFactor,
      { min: 0, max: 1 }
    ),
    // Associative thought chaining
    chainEnabled: parseBoolean(
      process.env.IDLE_CHAIN_ENABLED,
      DEFAULTS.chainEnabled
    ),
    chainMaxDepth: Math.round(
      parseNumber(process.env.IDLE_CHAIN_MAX_DEPTH, DEFAULTS.chainMaxDepth, {
        min: 1,
        max: 5,
      })
    ),
    chainProbability: parseNumber(
      process.env.IDLE_CHAIN_PROBABILITY,
      DEFAULTS.chainProbability,
      { min: 0, max: 1 }
    ),
    // Emotional momentum
    momentumEnabled: parseBoolean(
      process.env.IDLE_MOMENTUM_ENABLED,
      DEFAULTS.momentumEnabled
    ),
    momentumDecayRate: parseNumber(
      process.env.IDLE_MOMENTUM_DECAY_RATE,
      DEFAULTS.momentumDecayRate,
      { min: 0, max: 1 }
    ),
    momentumImpact: parseNumber(
      process.env.IDLE_MOMENTUM_IMPACT,
      DEFAULTS.momentumImpact,
      { min: 0, max: 1 }
    ),
    // Creativity save (random escape for deferred thoughts)
    creativitySaveRate: parseNumber(
      process.env.IDLE_CREATIVITY_SAVE_RATE,
      DEFAULTS.creativitySaveRate,
      { min: 0, max: 1 }
    ),
  };

  if (config.salienceEscalateThreshold < config.salienceStoreThreshold) {
    config.salienceEscalateThreshold = config.salienceStoreThreshold;
  }
  if (config.sparkIntervalMaxMs < config.sparkIntervalMinMs) {
    config.sparkIntervalMaxMs = config.sparkIntervalMinMs;
  }

  return config;
}
