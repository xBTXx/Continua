import { ensureSchema, query } from "./db";
import { createChatCompletion } from "./openrouter";
import { listVectors } from "./vector";
import { PERSONAL_MEMORY_COLLECTION } from "./personalMemory";
import {
  composeSystemPrompt,
  DEFAULT_PERSONA_PROFILE,
  DEFAULT_SYSTEM_PROMPT,
} from "./systemPromptDefaults";
import { getSystemPrompt } from "./systemPrompt";

const PERSONA_PROFILE_KEY = "persona_profile";
const CACHE_TTL_MS = 60 * 1000;
const CACHE_KEY = "__assistantPersonaProfileCache";

const PERSONA_EDITOR_MODEL =
  process.env.PERSONA_EDITOR_MODEL ?? "google/gemini-2.5-flash-lite";
const PERSONA_BIOGRAPHER_MODEL =
  process.env.PERSONA_BIOGRAPHER_MODEL ?? "google/gemini-3-pro-preview";
const PERSONA_BATCH_SIZE = Number(process.env.PERSONA_BATCH_SIZE ?? "120");
const PERSONA_RECENT_COUNT = Number(process.env.PERSONA_RECENT_COUNT ?? "30");
const PERSONA_MAX_MEMORIES = Number(process.env.PERSONA_MAX_MEMORIES ?? "1200");
const PERSONA_MIN_WORDS = Number(process.env.PERSONA_MIN_WORDS ?? "80");
const PERSONA_MAX_WORDS = Number(process.env.PERSONA_MAX_WORDS ?? "220");

type PersonaProfileCache = {
  value: string;
  loadedAt: number;
};

type PersonaMemoryEntry = {
  content: string;
  createdAt?: string;
  category?: string;
};

function getCache() {
  const scope = globalThis as typeof globalThis & {
    [CACHE_KEY]?: PersonaProfileCache;
  };
  return scope;
}

function readCache() {
  const scope = getCache();
  const cached = scope[CACHE_KEY];
  if (!cached) {
    return null;
  }
  if (Date.now() - cached.loadedAt > CACHE_TTL_MS) {
    return null;
  }
  return cached.value;
}

function writeCache(value: string) {
  const scope = getCache();
  scope[CACHE_KEY] = { value, loadedAt: Date.now() };
}

function normalizeCount(value: number, fallback: number, min = 1, max = 5000) {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function normalizePersonaText(raw: string) {
  let text = raw.replace(/\r/g, "").trim();
  text = text.replace(/^output:\s*/i, "");
  text = text.replace(/^persona description:\s*/i, "");
  text = text.replace(/^[`"']+|[`"']+$/g, "");
  text = text.replace(/^\s*[-*]\s+/g, "");
  text = text.replace(/\n+/g, " ");
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

function enforceWordLimit(text: string, minWords: number, maxWords: number) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < minWords) {
    return "";
  }
  if (words.length > maxWords) {
    return words.slice(0, maxWords).join(" ");
  }
  return text;
}

function formatDateLabel(raw?: string) {
  if (!raw) {
    return "unknown";
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return raw.slice(0, 10) || "unknown";
  }
  return date.toISOString().slice(0, 10);
}

function formatPersonaMemory(entry: PersonaMemoryEntry) {
  const dateLabel = formatDateLabel(entry.createdAt);
  const categoryLabel = entry.category ? `(${entry.category}) ` : "";
  return `- [${dateLabel}] ${categoryLabel}${entry.content}`;
}

function chunkEntries<T>(items: T[], size: number) {
  if (items.length === 0) {
    return [];
  }
  const safeSize = Math.max(1, size);
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += safeSize) {
    batches.push(items.slice(i, i + safeSize));
  }
  return batches;
}

function sortPersonaMemories(entries: PersonaMemoryEntry[]) {
  return [...entries].sort((a, b) => {
    const aTime = a.createdAt ? Date.parse(a.createdAt) : NaN;
    const bTime = b.createdAt ? Date.parse(b.createdAt) : NaN;
    const aValid = Number.isFinite(aTime);
    const bValid = Number.isFinite(bTime);
    if (aValid && bValid) {
      return aTime - bTime;
    }
    if (aValid) {
      return -1;
    }
    if (bValid) {
      return 1;
    }
    return 0;
  });
}

async function listPersonalMemories(limit: number) {
  const pageSize = 200;
  const maxCount = normalizeCount(limit, PERSONA_MAX_MEMORIES, 1, 5000);
  const entries: PersonaMemoryEntry[] = [];
  for (let offset = 0; entries.length < maxCount; offset += pageSize) {
    const result = await listVectors(pageSize, offset, PERSONAL_MEMORY_COLLECTION);
    if (result.ids.length === 0) {
      break;
    }
    result.documents.forEach((doc, index) => {
      if (typeof doc !== "string") {
        return;
      }
      const trimmed = doc.trim();
      if (!trimmed) {
        return;
      }
      const metadata = result.metadatas[index] ?? {};
      const createdAt =
        typeof metadata.created_at === "string" ? metadata.created_at : undefined;
      const category =
        typeof metadata.category === "string" ? metadata.category : undefined;
      entries.push({ content: trimmed, createdAt, category });
    });
    if (result.ids.length < pageSize) {
      break;
    }
  }
  return entries.slice(0, maxCount);
}

async function runEditorBatch(
  batch: PersonaMemoryEntry[],
  apiKey?: string,
  appUrl?: string
) {
  const memoryLines = batch.map(formatPersonaMemory).join("\n");
  const systemPrompt = [
    "You are an AI consolidation editor for persona memories.",
    "Extract distinct psychological traits, recurring feelings, and notable shifts.",
    "Do not list raw memories verbatim; synthesize them.",
    "If a theme repeats, note its frequency or intensity.",
    "When possible, mention time cues (e.g., dates or time ranges).",
    "Output a concise bullet list of insights only.",
  ].join("\n");
  const userPrompt = [
    "Personal memories (chronological):",
    memoryLines || "None",
    "",
    "Return bullet list only.",
  ].join("\n");

  const response = await createChatCompletion({
    model: PERSONA_EDITOR_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.3,
    stream: false,
    apiKey,
    appUrl,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || "Persona editor failed.");
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  return content.trim();
}

async function runBiographer(
  insights: string,
  timeline: string,
  apiKey?: string,
  appUrl?: string
) {
  const systemPrompt = [
    "You are an expert AI psychologist and biographer.",
    "Write a distinct, high-fidelity psychological profile of the assistant in the third person.",
    "Capture tone, relationship to the user, and recent evolution.",
    "Include interaction style and voice (e.g., warmth, boundaries, humor, sharpness) when supported by memories.",
    "If evidence is thin, keep style notes light and avoid overreach.",
    "Refer to the user as \"the user\" (do not use their name).",
    "Use the dated timeline to anchor changes over time.",
    "Format: one dense paragraph (150-200 words).",
    "Avoid bullet points and avoid listing raw facts.",
  ].join("\n");

  const userPrompt = [
    "Consolidated insights:",
    insights || "None",
    "",
    "Recent personal memory timeline (chronological, dated):",
    timeline || "None",
    "",
    "Output only the persona description.",
  ].join("\n");

  const response = await createChatCompletion({
    model: PERSONA_BIOGRAPHER_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.4,
    stream: false,
    reasoning: { effort: "high" },
    apiKey,
    appUrl,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || "Persona biographer failed.");
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  return content.trim();
}

export async function getPersonaProfile(): Promise<string> {
  const cached = readCache();
  if (cached !== null) {
    return cached;
  }

  await ensureSchema();
  const result = await query<{ value: string }>(
    "SELECT value FROM app_settings WHERE key = $1 LIMIT 1",
    [PERSONA_PROFILE_KEY]
  );
  const stored = result.rows[0]?.value;
  const value = typeof stored === "string" ? stored : "";
  writeCache(value);
  return value;
}

export async function setPersonaProfile(value: string) {
  const trimmed = value.trim();
  await ensureSchema();
  await query(
    `
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `,
    [PERSONA_PROFILE_KEY, trimmed]
  );
  writeCache(trimmed);
  return { status: "ok" as const };
}

export async function getCompositeSystemPrompt() {
  const [basePrompt, personaProfile] = await Promise.all([
    getSystemPrompt().catch(() => DEFAULT_SYSTEM_PROMPT),
    getPersonaProfile().catch(() => ""),
  ]);
  return composeSystemPrompt(basePrompt, personaProfile);
}

export async function generatePersonaProfile(options?: {
  apiKey?: string;
  appUrl?: string;
  maxMemories?: number;
}) {
  const maxMemories = normalizeCount(
    options?.maxMemories ?? PERSONA_MAX_MEMORIES,
    PERSONA_MAX_MEMORIES,
    1,
    5000
  );
  const batchSize = normalizeCount(PERSONA_BATCH_SIZE, 120, 20, 300);
  const recentCount = normalizeCount(PERSONA_RECENT_COUNT, 30, 5, 100);
  const minWords = normalizeCount(PERSONA_MIN_WORDS, 90, 40, 200);
  const maxWords = normalizeCount(PERSONA_MAX_WORDS, 220, minWords, 400);

  const entries = await listPersonalMemories(maxMemories);
  if (entries.length === 0) {
    return {
      persona: DEFAULT_PERSONA_PROFILE,
      sourceCount: 0,
      usedFallback: true,
    };
  }

  const sorted = sortPersonaMemories(entries);
  const batches = chunkEntries(sorted, batchSize);
  const insightsBlocks: string[] = [];

  for (const batch of batches) {
    try {
      const block = await runEditorBatch(batch, options?.apiKey, options?.appUrl);
      if (block.trim()) {
        insightsBlocks.push(block.trim());
      }
    } catch (error) {
      console.warn("Persona editor batch failed.", error);
    }
  }

  const insightsText =
    insightsBlocks.length > 0 ? insightsBlocks.join("\n") : "None";
  const recentTimeline = sorted
    .slice(Math.max(0, sorted.length - recentCount))
    .map(formatPersonaMemory)
    .join("\n");

  let personaRaw = "";
  try {
    personaRaw = await runBiographer(
      insightsText,
      recentTimeline,
      options?.apiKey,
      options?.appUrl
    );
  } catch (error) {
    console.warn("Persona biographer failed.", error);
  }

  const cleaned = normalizePersonaText(personaRaw);
  const limited = enforceWordLimit(cleaned, minWords, maxWords);
  if (!limited) {
    return {
      persona: DEFAULT_PERSONA_PROFILE,
      sourceCount: entries.length,
      usedFallback: true,
    };
  }

  return {
    persona: limited,
    sourceCount: entries.length,
    usedFallback: false,
  };
}
