import { countVectors, listVectors } from "../vector";
import { PERSONAL_MEMORY_COLLECTION } from "../personalMemory";
import { listPersonalMemoryContexts } from "../personalMemoryContext";
import {
  MAX_SEEDS_LIMIT,
  MAX_SEED_LENGTH,
} from "./constants";
import {
  IdleSeed,
  IdleSeedSource,
  IdleConfig,
  IdleRuntimeState,
} from "./types";
import {
  truncateText,
  dedupeSeeds,
  formatContextSnippet,
  formatSeedMetadata,
  formatSeedUsage,
} from "./utils";

/**
 * Compute a weight for a seed based on recency, resonance intensity, and access frequency.
 * Higher weight = more likely to be selected.
 */
function computeSeedWeight(
  seed: IdleSeed,
  config: IdleConfig,
  state?: IdleRuntimeState,
  nowMs?: number
): number {
  const now = nowMs ?? Date.now();

  // 1. Recency factor: exponential decay based on age
  let recencyWeight = 0.5; // Default for no timestamp
  if (seed.createdAt) {
    const createdAtMs = new Date(seed.createdAt).getTime();
    if (!Number.isNaN(createdAtMs)) {
      const ageMs = now - createdAtMs;
      const halfLife = config.seedWeightRecencyHalfLifeMs;
      recencyWeight = Math.exp(-0.693 * ageMs / halfLife); // ln(2) ≈ 0.693
    }
  }

  // 2. Resonance intensity factor (1-5 scale, normalized to 0-1)
  let intensityWeight = 0.4; // Default for no metadata
  const metadata = seed.metadata;
  if (metadata) {
    const intensity = metadata.resonance_intensity ?? metadata.idle_salience;
    if (typeof intensity === "number" && intensity >= 1 && intensity <= 5) {
      intensityWeight = intensity / 5;
    } else if (typeof metadata.idle_salience === "number") {
      intensityWeight = Math.min(1, Math.max(0, metadata.idle_salience as number));
    }
  }

  // 3. Recent access frequency factor (if state available)
  let frequencyWeight = 0;
  if (state) {
    const useCount = state.seedUseCounts[seed.id] ?? 0;
    const lastUsed = state.lastSeedUsedAt[seed.id] ?? 0;
    // Boost seeds that were accessed recently (within last hour)
    if (lastUsed > 0 && now - lastUsed < 60 * 60 * 1000) {
      frequencyWeight = 0.5 * Math.exp(-0.693 * (now - lastUsed) / (30 * 60 * 1000));
    }
    // Slight penalty for overused seeds
    if (useCount > 3) {
      frequencyWeight -= 0.2 * Math.min(1, (useCount - 3) / 5);
    }
  }

  // Combine factors with configurable weights
  const combined =
    recencyWeight * config.seedWeightRecencyFactor +
    intensityWeight * config.seedWeightIntensityFactor +
    frequencyWeight * config.seedWeightFrequencyFactor;

  // Ensure minimum weight of 0.05 so no seed is completely ignored
  return Math.max(0.05, Math.min(1, combined));
}

/**
 * Select indices using weighted random sampling without replacement.
 */
function weightedRandomSample(
  weights: number[],
  count: number
): number[] {
  if (weights.length === 0 || count <= 0) {
    return [];
  }

  const indices: number[] = [];
  const remainingWeights = [...weights];
  const remainingIndices = weights.map((_, i) => i);

  const sampleCount = Math.min(count, weights.length);

  for (let i = 0; i < sampleCount; i++) {
    // Compute cumulative weights
    let totalWeight = 0;
    for (const w of remainingWeights) {
      totalWeight += w;
    }

    if (totalWeight <= 0) {
      // All remaining weights are zero, select randomly
      const randomIdx = Math.floor(Math.random() * remainingIndices.length);
      indices.push(remainingIndices[randomIdx]);
      remainingWeights.splice(randomIdx, 1);
      remainingIndices.splice(randomIdx, 1);
      continue;
    }

    // Select based on weighted random
    const threshold = Math.random() * totalWeight;
    let cumulative = 0;
    let selectedIdx = 0;

    for (let j = 0; j < remainingWeights.length; j++) {
      cumulative += remainingWeights[j];
      if (cumulative >= threshold) {
        selectedIdx = j;
        break;
      }
    }

    indices.push(remainingIndices[selectedIdx]);
    remainingWeights.splice(selectedIdx, 1);
    remainingIndices.splice(selectedIdx, 1);
  }

  return indices;
}

async function sampleCollectionSeeds(
  collectionName: string | undefined,
  count: number,
  source: IdleSeedSource,
  config: IdleConfig,
  state?: IdleRuntimeState
) {
  if (!Number.isFinite(count) || count <= 0) {
    return [];
  }

  const total = await countVectors(collectionName);
  if (total <= 0) {
    return [];
  }

  // Fetch more candidates than needed for better weighted sampling
  const candidateCount = Math.min(total, Math.max(count * 3, 20), MAX_SEEDS_LIMIT * 2);
  const offsets = new Set<number>();
  const maxAttempts = candidateCount * 5;
  let attempts = 0;

  while (offsets.size < candidateCount && attempts < maxAttempts) {
    offsets.add(Math.floor(Math.random() * total));
    attempts += 1;
  }

  const results = await Promise.all(
    Array.from(offsets).map((offset) =>
      listVectors(1, offset, collectionName)
    )
  );

  const candidates: IdleSeed[] = [];
  const nowMs = Date.now();

  results.forEach((result, index) => {
    const doc = result.documents?.[0];
    if (typeof doc !== "string" || doc.trim().length === 0) {
      return;
    }
    const metadata = result.metadatas?.[0] ?? null;
    const metadataSource = metadata?.source ?? null;
    if (source === "personal_memory" && metadataSource === "idle_state") {
      return;
    }
    const createdAt =
      metadata && typeof metadata.created_at === "string"
        ? metadata.created_at
        : null;
    const rawId = result.ids?.[0];
    const id = typeof rawId === "string" ? rawId : `${source}-${index}`;
    candidates.push({
      id,
      source,
      content: truncateText(doc, MAX_SEED_LENGTH),
      createdAt,
      metadata: metadata ?? null,
    });
  });

  if (candidates.length === 0) {
    return [];
  }

  // Compute weights for all candidates
  const weights = candidates.map((seed) =>
    computeSeedWeight(seed, config, state, nowMs)
  );

  // Select using weighted random sampling
  const sampleCount = Math.min(Math.max(1, count), candidates.length);
  const selectedIndices = weightedRandomSample(weights, sampleCount);

  return selectedIndices.map((idx) => candidates[idx]);
}

async function getContextSeeds(limit: number) {
  if (!Number.isFinite(limit) || limit <= 0) {
    return [];
  }
  const contexts = await listPersonalMemoryContexts(limit);
  const seeds: IdleSeed[] = [];

  for (const context of contexts) {
    const snippet = formatContextSnippet(context.messages);
    const content = truncateText(snippet, MAX_SEED_LENGTH);
    if (!content) {
      continue;
    }
    seeds.push({
      id: `context:${context.id}`,
      source: "personal_context",
      content,
      createdAt: context.createdAt,
      metadata: {
        source: "personal_context",
        context_id: context.id,
        personal_memory_id: context.personalMemoryId,
      },
    });
  }

  return seeds;
}

export async function collectIdleSeeds(
  config: IdleConfig,
  state?: IdleRuntimeState
) {
  const totalSeeds = Math.min(
    MAX_SEEDS_LIMIT,
    Math.max(6, config.topK)
  );
  const mainCount = Math.max(1, Math.ceil(totalSeeds * 0.5));
  const personalCount = Math.max(1, Math.ceil(totalSeeds * 0.3));
  const contextCount = Math.max(1, totalSeeds - mainCount - personalCount);

  const [mainSeeds, personalSeeds, contextSeeds] = await Promise.all([
    sampleCollectionSeeds(undefined, mainCount, "main_memory", config, state),
    sampleCollectionSeeds(
      PERSONAL_MEMORY_COLLECTION,
      personalCount,
      "personal_memory",
      config,
      state
    ),
    getContextSeeds(contextCount),
  ]);

  const combined = dedupeSeeds([
    ...mainSeeds,
    ...personalSeeds,
    ...contextSeeds,
  ]);

  return combined.slice(0, MAX_SEEDS_LIMIT);
}

export function buildSeedList(
  seeds: IdleSeed[],
  options?: {
    lastSeedUsedAt?: Record<string, number>;
    seedUseCounts?: Record<string, number>;
    nowMs?: number;
  }
) {
  const lastSeedUsedAt = options?.lastSeedUsedAt ?? {};
  const seedUseCounts = options?.seedUseCounts ?? {};
  const nowMs = options?.nowMs ?? Date.now();
  return seeds
    .map(
      (seed, index) => {
        const lines = [
          `${index + 1}. [${seed.id}] (${seed.source}) ${seed.content}`,
        ];
        const metaLine = formatSeedMetadata(seed);
        if (metaLine) {
          lines.push(`   meta: ${metaLine}`);
        }
        const usageLine = formatSeedUsage(
          seed.id,
          lastSeedUsedAt,
          seedUseCounts,
          nowMs
        );
        if (usageLine) {
          lines.push(`   usage: ${usageLine}`);
        }
        return lines.join("\n");
      }
    )
    .join("\n");
}
