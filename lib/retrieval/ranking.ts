import {
  CROSS_COLLECTION_EXPANSION_ENABLED,
  CROSS_COLLECTION_MAX_TOPICS,
  STALENESS_CORE_DECAY_FACTOR,
  STALENESS_DECAY_ENABLED,
  STALENESS_DECAY_HALF_LIFE_DAYS,
} from "./config";
import { parseTagList } from "./helpers";
import type { MemorySnippet } from "./types";

function matchesResonanceTags(memory: MemorySnippet, tags: string[]) {
  if (tags.length === 0) {
    return true;
  }
  const raw = memory.resonanceTagsFlat;
  if (!raw) {
    return false;
  }
  const memoryTags = new Set(parseTagList(raw));
  return tags.some((tag) => memoryTags.has(tag));
}

export function rankResonanceMemories(
  memories: MemorySnippet[],
  resonanceTags: string[]
) {
  return [...memories].sort((a, b) => {
    const aWeight = a.resonanceWeight ?? "transient";
    const bWeight = b.resonanceWeight ?? "transient";
    const weightOrder = new Map([
      ["core", 4],
      ["pivot", 3],
      ["notable", 2],
      ["transient", 1],
    ]);
    const aScore = weightOrder.get(aWeight) ?? 0;
    const bScore = weightOrder.get(bWeight) ?? 0;
    if (aScore !== bScore) {
      return bScore - aScore;
    }
    const aIntensity = a.resonanceIntensity ?? 0;
    const bIntensity = b.resonanceIntensity ?? 0;
    if (aIntensity !== bIntensity) {
      return bIntensity - aIntensity;
    }
    const aMatches = matchesResonanceTags(a, resonanceTags) ? 1 : 0;
    const bMatches = matchesResonanceTags(b, resonanceTags) ? 1 : 0;
    if (aMatches !== bMatches) {
      return bMatches - aMatches;
    }
    return 0;
  });
}

/**
 * Extract key topics from memory content for cross-collection expansion.
 * Uses simple NLP heuristics to identify nouns/topics.
 */
export function extractTopicsFromMemories(
  memories: MemorySnippet[],
  maxTopics: number = CROSS_COLLECTION_MAX_TOPICS
): string[] {
  if (!CROSS_COLLECTION_EXPANSION_ENABLED || memories.length === 0) {
    return [];
  }

  // Combine memory content
  const combinedContent = memories
    .map((m) => m.content)
    .join(" ")
    .toLowerCase();

  // Common words to exclude
  const STOPWORDS = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "must", "can", "to", "of", "in", "for",
    "on", "with", "at", "by", "from", "as", "into", "through", "during",
    "before", "after", "above", "below", "between", "under", "again",
    "further", "then", "once", "here", "there", "when", "where", "why",
    "how", "all", "each", "few", "more", "most", "other", "some", "such",
    "no", "nor", "not", "only", "own", "same", "so", "than", "too", "very",
    "just", "and", "but", "or", "if", "because", "until", "while", "about",
    "against", "out", "up", "down", "off", "over", "any", "both", "this",
    "that", "these", "those", "what", "which", "who", "whom", "user",
    "assistant", "i", "you", "he", "she", "it", "we", "they", "me", "him",
    "her", "us", "them", "my", "your", "his", "its", "our", "their",
    "myself", "yourself", "like", "likes", "enjoy", "enjoys", "think",
    "thinks", "feel", "feels", "notice", "noticed", "remember", "remembered",
  ]);

  // Extract words (4+ chars, not stopwords)
  const words = combinedContent
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !STOPWORDS.has(word));

  // Count word frequencies
  const wordCounts = new Map<string, number>();
  for (const word of words) {
    wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
  }

  // Sort by frequency and take top N
  const topTopics = Array.from(wordCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTopics)
    .map(([word]) => word);

  return topTopics;
}

/**
 * Apply time-based staleness decay to memory scores.
 * Recent memories get higher scores; old memories get penalized.
 * Core resonance weight memories decay slower.
 */
export function applyStalenesDecay(
  memories: MemorySnippet[]
): Array<MemorySnippet & { freshnessScore: number }> {
  if (!STALENESS_DECAY_ENABLED) {
    return memories.map((m) => ({ ...m, freshnessScore: 1 }));
  }

  const now = Date.now();

  return memories.map((memory) => {
    let freshnessScore = 1;

    if (memory.createdAt) {
      const createdMs = new Date(memory.createdAt).getTime();
      if (!isNaN(createdMs)) {
        const ageMs = now - createdMs;
        const ageDays = ageMs / (1000 * 60 * 60 * 24);

        // Exponential decay: score = 0.5^(age/half_life)
        let effectiveHalfLife = STALENESS_DECAY_HALF_LIFE_DAYS;

        // Core memories decay slower
        if (memory.resonanceWeight === "core") {
          effectiveHalfLife = STALENESS_DECAY_HALF_LIFE_DAYS / STALENESS_CORE_DECAY_FACTOR;
        } else if (memory.resonanceWeight === "pivot") {
          effectiveHalfLife = STALENESS_DECAY_HALF_LIFE_DAYS * 1.5;
        }

        freshnessScore = Math.pow(0.5, ageDays / effectiveHalfLife);
        // Clamp to minimum of 0.1 to avoid completely ignoring old memories
        freshnessScore = Math.max(0.1, freshnessScore);
      }
    }

    return { ...memory, freshnessScore };
  });
}

/**
 * Sort memories by freshness score (higher = more recent/important).
 */
export function sortByFreshness(
  memories: Array<MemorySnippet & { freshnessScore: number }>
): MemorySnippet[] {
  return [...memories]
    .sort((a, b) => b.freshnessScore - a.freshnessScore)
    .map((memory) => {
      const { freshnessScore, ...rest } = memory;
      void freshnessScore;
      return rest as MemorySnippet;
    });
}
