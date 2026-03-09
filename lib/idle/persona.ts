import modelsData from "@/config/models.json";
import { getPersonaProfile } from "../persona";
import { getSystemPrompt } from "../systemPrompt";
import { generateEmbedding } from "../embeddings";
import {
  composeSystemPrompt,
  DEFAULT_PERSONA_PROFILE,
  DEFAULT_SYSTEM_PROMPT,
} from "../systemPromptDefaults";
import {
  PERSONA_MIN_SEMANTIC_TOPICS,
} from "./constants";
import {
  IdleConfig,
  PersonaFocusCache,
} from "./types";
import {
  extractPersonaFocusKeywords,
  normalizeThought,
  getPersonaTokens,
  cosineSimilarity,
} from "./utils";

const embeddingsConfig = modelsData.embeddings;

export async function getPersonaAnchor(config: IdleConfig) {
  if (config.personaMode === "off") {
    return "";
  }

  const staticPersona = (process.env.IDLE_PERSONA_TEXT ?? "").trim();
  const envDynamicPersona = (process.env.IDLE_PERSONA_PROFILE ?? "").trim();
  const storedDynamicPersona = await getPersonaProfile().catch(() => "");
  const dynamicPersona = envDynamicPersona || storedDynamicPersona;
  const fallbackPersona = DEFAULT_PERSONA_PROFILE;
  const serverPersona = await getSystemPrompt().catch(() => "");
  const basePrompt = staticPersona || serverPersona;

  let source = config.personaSource;
  if (config.personaMode === "static") {
    source = "system_prompt";
  }
  if (config.personaMode === "dynamic") {
    source = "persona_profile";
  }

  if (source === "system_prompt") {
    return composeSystemPrompt(basePrompt || DEFAULT_SYSTEM_PROMPT, dynamicPersona);
  }
  if (source === "persona_profile") {
    return dynamicPersona || fallbackPersona;
  }

  const combined = [staticPersona, dynamicPersona].filter(Boolean).join("\n");
  if (combined) {
    return combined;
  }
  return composeSystemPrompt(basePrompt || DEFAULT_SYSTEM_PROMPT, dynamicPersona);
}

export async function buildPersonaFocusCache(
  personaText: string,
  state: { personaFocusCache: PersonaFocusCache | null }
) {
  const trimmed = personaText.trim();
  if (!trimmed) {
    state.personaFocusCache = null;
    return null;
  }
  if (state.personaFocusCache?.personaText === trimmed) {
    return state.personaFocusCache;
  }

  const keywords = extractPersonaFocusKeywords(trimmed);
  if (keywords.length === 0) {
    const emptyCache: PersonaFocusCache = {
      personaText: trimmed,
      keywords,
      embeddings: [],
      updatedAt: Date.now(),
    };
    state.personaFocusCache = emptyCache;
    return emptyCache;
  }

  if (keywords.length < PERSONA_MIN_SEMANTIC_TOPICS) {
    const limitedCache: PersonaFocusCache = {
      personaText: trimmed,
      keywords,
      embeddings: [],
      updatedAt: Date.now(),
    };
    state.personaFocusCache = limitedCache;
    return limitedCache;
  }

  const embeddingModel =
    embeddingsConfig?.model ?? "google/gemini-embedding-001";
  const results = await Promise.allSettled(
    keywords.map((keyword) => generateEmbedding(keyword, embeddingModel))
  );
  const embeddings = results.map((result) =>
    result.status === "fulfilled" ? result.value : []
  );

  const cache: PersonaFocusCache = {
    personaText: trimmed,
    keywords,
    embeddings,
    updatedAt: Date.now(),
  };
  state.personaFocusCache = cache;
  return cache;
}

export function hasPersonaKeywordMatch(thoughtText: string, personaText: string) {
  if (!personaText.trim() || !thoughtText.trim()) {
    return false;
  }
  const keywords = extractPersonaFocusKeywords(personaText);
  if (keywords.length === 0) {
    return false;
  }
  const normalizedThought = normalizeThought(thoughtText);
  if (!normalizedThought) {
    return false;
  }
  const thoughtTokens = new Set(getPersonaTokens(normalizedThought));

  for (const keyword of keywords) {
    const normalizedKeyword = normalizeThought(keyword);
    if (!normalizedKeyword) {
      continue;
    }
    if (normalizedThought.includes(normalizedKeyword)) {
      return true;
    }
    const keywordTokens = getPersonaTokens(normalizedKeyword);
    for (const token of keywordTokens) {
      if (thoughtTokens.has(token)) {
        return true;
      }
    }
  }
  return false;
}

export async function hasPersonaSemanticMatch(
  thoughtText: string,
  personaCache: PersonaFocusCache | null,
  similarityThreshold: number
) {
  if (!personaCache || personaCache.keywords.length === 0) {
    return false;
  }
  if (personaCache.embeddings.length === 0) {
    return false;
  }
  const trimmedThought = thoughtText.trim();
  if (!trimmedThought) {
    return false;
  }
  const embeddingModel =
    embeddingsConfig?.model ?? "google/gemini-embedding-001";
  try {
    const thoughtEmbedding = await generateEmbedding(
      trimmedThought,
      embeddingModel
    );
    if (thoughtEmbedding.length === 0) {
      return false;
    }
    for (const keywordEmbedding of personaCache.embeddings) {
      if (keywordEmbedding.length === 0) {
        continue;
      }
      const similarity = cosineSimilarity(thoughtEmbedding, keywordEmbedding);
      if (similarity >= similarityThreshold) {
        return true;
      }
    }
  } catch (error) {
    console.warn("Persona semantic match failed.", error);
  }
  return false;
}
