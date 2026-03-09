import {
  ACTION_CUE_REGEX,
  ENERGY_MIN,
  ENERGY_MAX,
  ESCALATE_THRESHOLD_MAX,
  ESCALATE_THRESHOLD_BUFFER,
  RELATED_THOUGHT_LIMIT,
  RELATED_THOUGHT_MIN_OVERLAP,
} from "./constants";
import {
  IdleThought,
  IdleSeed,
  IdleRuntimeState,
  IdleConfig,
  IdleEvaluation,
  IdleDecision,
  PersonaMatchType,
  PersonaFocusCache,
} from "./types";
import {
  normalizeThought,
  getThoughtTokens,
  clampNumber,
} from "./utils";
import {
  hasPersonaKeywordMatch,
  hasPersonaSemanticMatch,
} from "./persona";
import { getMomentumScoreAdjustment } from "./config";

export function getRelatedThoughts(thought: string, state: IdleRuntimeState) {
  const currentNorm = normalizeThought(thought);
  if (!currentNorm) {
    return [];
  }
  const currentTokens = new Set(getThoughtTokens(currentNorm));
  const related: string[] = [];
  const seen = new Set<string>();

  for (const prior of state.recentThoughts) {
    if (typeof prior !== "string") {
      continue;
    }
    if (!prior || related.length >= RELATED_THOUGHT_LIMIT) {
      break;
    }
    const priorNorm = normalizeThought(prior);
    if (!priorNorm || priorNorm === currentNorm) {
      continue;
    }
    if (priorNorm.includes(currentNorm) || currentNorm.includes(priorNorm)) {
      const trimmed = prior.trim();
      if (!seen.has(trimmed)) {
        related.push(trimmed);
        seen.add(trimmed);
      }
      continue;
    }

    const priorTokens = getThoughtTokens(priorNorm);
    let overlap = 0;
    for (const token of priorTokens) {
      if (currentTokens.has(token)) {
        overlap += 1;
        if (overlap >= RELATED_THOUGHT_MIN_OVERLAP) {
          break;
        }
      }
    }
    if (overlap >= RELATED_THOUGHT_MIN_OVERLAP) {
      const trimmed = prior.trim();
      if (!seen.has(trimmed)) {
        related.push(trimmed);
        seen.add(trimmed);
      }
    }
  }

  return related;
}

export function isSimilarThought(thought: string, recentThoughts: string[]) {
  const normalized = normalizeThought(thought);
  if (!normalized) {
    return false;
  }
  const currentTokens = new Set(getThoughtTokens(normalized));
  return recentThoughts.some((prior) => {
    if (typeof prior !== "string") {
      return false;
    }
    const priorNorm = normalizeThought(prior);
    if (!priorNorm) {
      return false;
    }
    if (priorNorm === normalized) {
      return true;
    }
    if (priorNorm.includes(normalized) || normalized.includes(priorNorm)) {
      return true;
    }
    const priorTokens = getThoughtTokens(priorNorm);
    let overlap = 0;
    for (const token of priorTokens) {
      if (currentTokens.has(token)) {
        overlap += 1;
        if (overlap >= RELATED_THOUGHT_MIN_OVERLAP) {
          return true;
        }
      }
    }
    return false;
  });
}

export async function scoreIdleThought(
  thought: IdleThought,
  seed: IdleSeed,
  state: IdleRuntimeState,
  config: IdleConfig,
  personaText: string,
  personaFocusCache: PersonaFocusCache | null
): Promise<IdleEvaluation> {
  let score = 0.2;
  const hasActionCue = ACTION_CUE_REGEX.test(thought.thought);

  const temporal = thought.tas?.temporal ?? "present";
  const valence = thought.tas?.valence ?? "neutral";
  const selfRel = thought.tas?.self_relevance ?? "medium";
  const novelty = thought.tas?.novelty ?? "low";
  const noveltyLowBoost = clampNumber(config.noveltyLowBoost, 0, 1);
  const noveltyMediumBoost = clampNumber(config.noveltyMediumBoost, 0, 1);
  const noveltyHighBoost = clampNumber(config.noveltyHighBoost, 0, 1);

  if (temporal === "future") {
    score += 0.1;
  } else if (temporal === "present") {
    score += 0.05;
  } else if (temporal === "past") {
    score += 0.05;
  }

  if (valence === "negative") {
    score += 0.15;
  } else if (valence === "positive") {
    score += 0.1;
  } else {
    score += 0.05;
  }

  if (selfRel === "high") {
    score += 0.25;
  } else if (selfRel === "medium") {
    score += 0.15;
  } else {
    score += 0.05;
  }

  if (novelty === "high") {
    score += noveltyHighBoost;
  } else if (novelty === "medium") {
    score += noveltyMediumBoost;
  } else {
    score += noveltyLowBoost;
  }

  if (hasActionCue) {
    score += 0.2;
  }

  if (seed.source === "personal_context") {
    score += 0.1;
  } else if (seed.source === "personal_memory") {
    score += 0.05;
  }

  const personaKeywordMatch = hasPersonaKeywordMatch(
    thought.thought,
    personaText
  );
  let personaMatch: PersonaMatchType = null;
  if (personaKeywordMatch) {
    const keywordBoost = clampNumber(config.personaKeywordBoost, 0, 1);
    score += keywordBoost;
    personaMatch = "keyword";
  } else {
    const semanticThreshold = clampNumber(
      config.personaSemanticThreshold,
      0,
      1
    );
    const semanticMatch = await hasPersonaSemanticMatch(
      thought.thought,
      personaFocusCache,
      semanticThreshold
    );
    if (semanticMatch) {
      const semanticBoost = clampNumber(config.personaSemanticBoost, 0, 1);
      score += semanticBoost;
      personaMatch = "semantic";
    }
  }

  const similar = isSimilarThought(thought.thought, state.recentThoughts);
  if (similar) {
    score -= 0.2;
  }

  // Apply emotional momentum adjustment
  const momentumAdjustment = getMomentumScoreAdjustment(
    state.emotionalMomentum,
    valence,
    config
  );
  score += momentumAdjustment;

  score = Math.max(0, Math.min(1, score));

  const energy = clampNumber(state.currentEnergy, ENERGY_MIN, ENERGY_MAX);
  const rawEscalateThreshold =
    config.salienceEscalateThreshold * (1.2 - energy * 0.4);
  const minEscalateThreshold = Math.min(
    ESCALATE_THRESHOLD_MAX,
    config.salienceStoreThreshold + ESCALATE_THRESHOLD_BUFFER
  );
  const dynamicEscalateThreshold = clampNumber(
    rawEscalateThreshold,
    minEscalateThreshold,
    ESCALATE_THRESHOLD_MAX
  );

  let decision: IdleDecision = "defer";
  if (score >= dynamicEscalateThreshold) {
    decision = "escalate";
  } else if (score >= config.salienceStoreThreshold) {
    decision = "store";
  }

  if (decision !== "defer" && similar && !hasActionCue) {
    decision = "defer";
  }

  if (decision === "escalate") {
    const lastEscalated = state.lastEscalatedBySeed[seed.id] ?? 0;
    if (lastEscalated > 0 && Date.now() - lastEscalated < config.salienceCooldownMs) {
      decision = "store";
    }
  }

  // Creativity save: random escape for deferred thoughts
  // This ensures some background creative accumulation even when energy is low
  if (decision === "defer" && config.creativitySaveRate > 0) {
    if (Math.random() < config.creativitySaveRate) {
      decision = "store";
    }
  }

  return { score, decision, isSimilar: similar, personaMatch };
}
