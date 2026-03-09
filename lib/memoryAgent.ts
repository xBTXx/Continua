import modelsData from "@/config/models.json";
import { createChatCompletion } from "./openrouter";
import { generateEmbedding } from "./embeddings";
import { queryVectors, upsertVectors, VectorRecord } from "./vector";
import { randomUUID } from "node:crypto";

type MemoryMessage = {
  id?: string;
  role: "user" | "assistant";
  content: string;
};

type MemoryAgentInput = {
  messages: MemoryMessage[];
  apiKey?: string;
  appUrl?: string;
  conversationId?: string | null;
};

type MemoryAgentResult = {
  stored: number;
  candidates: number;
  newMemories: string[];
};

type DeprecatedMemoryItem = {
  id: string;
  reason?: string;
};

const memoryAgentConfig = modelsData.memory_agent;
const embeddingsConfig = modelsData.embeddings;

const WARSAW_TIMEZONE = "Europe/Warsaw";
const EVENT_MEMORY_TTL_DAYS = 7;
const EVENT_KEYWORDS = [
  "appointment",
  "birthday",
  "breakfast",
  "call",
  "conference",
  "deadline",
  "dentist",
  "dinner",
  "doctor",
  "exam",
  "flight",
  "gym",
  "interview",
  "lunch",
  "meeting",
  "party",
  "reservation",
  "travel",
  "trip",
  "visit",
  "wedding",
  "workout",
  "anniversary",
  "booking",
  "concert",
  "spotkanie",
  "kolacja",
  "obiad",
  "sniadanie",
  "wizyta",
  "telefon",
  "rozmowa",
  "lot",
  "wyjazd",
  "podroz",
  "lekarz",
  "dentysta",
  "urodziny",
  "rocznica",
  "egzamin",
  "konferencja",
  "slub",
  "impreza",
  "koncert",
  "rezerwacja",
  "trening",
];
const EVENT_KEYWORD_REGEX = new RegExp(`\\b(${EVENT_KEYWORDS.join("|")})\\b`, "i");
const TEMPORAL_WINDOW_MIN = 20;
const MONTH_NAME_MAP: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sept: 9,
  sep: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
  styczen: 1,
  stycznia: 1,
  sty: 1,
  luty: 2,
  lutego: 2,
  lut: 2,
  marzec: 3,
  marca: 3,
  kwiecien: 4,
  kwietnia: 4,
  kwi: 4,
  maj: 5,
  maja: 5,
  czerwiec: 6,
  czerwca: 6,
  cze: 6,
  lipiec: 7,
  lipca: 7,
  lip: 7,
  sierpien: 8,
  sierpnia: 8,
  sie: 8,
  wrzesien: 9,
  wrzesnia: 9,
  wrz: 9,
  pazdziernik: 10,
  pazdziernika: 10,
  paz: 10,
  listopad: 11,
  listopada: 11,
  lis: 11,
  grudzien: 12,
  grudnia: 12,
  gru: 12,
};
const MONTH_NAME_REGEX = new RegExp(
  `\\b(\\d{1,2})\\s*(${Object.keys(MONTH_NAME_MAP).join("|")})(?:\\s*(\\d{4}))?\\b`,
  "i"
);

const RESONANCE_TAGS = [
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
const RESONANCE_TAG_SET = new Set(RESONANCE_TAGS);
const RESONANCE_WEIGHTS = ["core", "pivot", "notable", "transient"] as const;
const RESONANCE_STATES = [
  "expansive",
  "protective",
  "quiet",
  "focused",
  "playful",
  "tender",
  "analytical",
  "restless",
  "grounded",
] as const;
const RESONANCE_STATE_SET = new Set<string>(RESONANCE_STATES);
const RESONANCE_WEIGHT_SET = new Set<string>(RESONANCE_WEIGHTS);

const MEMORY_AGENT_PROMPT = `You are an intelligent Memory Agent. Your goal is to extract important, long-term facts about the user from the recent conversation.

Classify every new memory into one of these specific categories (tags):
- "profile": User identity, traits, specific preferences, or personality (e.g., "User is vegan", "User hates waiting").
- "work": Professional life, career, projects, code, or business (e.g., "User is working on a React app", "Deadline is Friday").
- "social": Relationships, family, friends, or specific people mentioned (e.g., "User's sister is named Sarah").
- "health": Medical, fitness, diet, sleep, or mental well-being.
- "media": Entertainment, books, movies, music, games.
- "event": (Time-bound) Appointments, meetings, travel. Resolve specific dates/times.
- "fact": General notes, random knowledge, or anything that doesn't fit above.

Also provide resonance metadata:
- "resonance_tags": 0-3 tags from this list only:
  ${RESONANCE_TAGS.join(", ")}
- "resonance_weight": one of core, pivot, notable, transient (use transient if low weight).
- "resonance_intensity": integer 1-5 (1 low, 5 high).
- "resonance_state": one of ${RESONANCE_STATES.join(", ")}.
- "resonance_motifs": optional short motifs (0-3 freeform strings).

COMPARE with the 'Old candidate memories':
1. If a fact is already known, IGNORE IT.
2. If a new fact is a SUBSET or less specific version of an old one, IGNORE IT. (e.g. New: "User likes wine", Old: "User prefers dry red wine" -> IGNORE New).
3. If a new fact CONTRADICTS an old one, or is a MORE SPECIFIC update (SUPERSEDES), add the old memory ID to "deprecated_memories" and include the new fact in "new_memories".
4. If the conversation is casual/chitchat with no new facts, return empty arrays.

Output format: JSON object.
{
  "new_memories": [
    {
      "content": "User prefers dry wine.",
      "tags": ["profile"],
      "resonance_tags": ["grounded"],
      "resonance_weight": "transient",
      "resonance_intensity": 2,
      "resonance_state": "quiet",
      "resonance_motifs": ["taste", "preference"]
    }
  ],
  "deprecated_memories": [
    { "id": "uuid-of-old-memory", "reason": "contradicted" }
  ]
}`;

type DateParts = {
  year: number;
  month: number;
  day: number;
};

type TimeParts = {
  hour: number;
  minute: number;
};

type EventMemory = {
  content: string;
  eventTime?: string;
  expiresAt?: string;
};

type MemoryMetadata = Record<string, string | number | boolean | null>;
type MemoryItem = {
  content: string;
  tags: string[];
  resonanceTags?: string[];
  resonanceWeight?: string | null;
  resonanceIntensity?: number | null;
  resonanceState?: string | null;
  resonanceMotifs?: string[];
};

function pad2(value: number) {
  return value.toString().padStart(2, "0");
}

function normalizeText(text: string) {
  return text
    .toLowerCase()
    .replace(/ł/g, "l")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeMessageId(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeConversationId(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeTags(value: unknown): string[] {
  if (!value) {
    return [];
  }
  const tags = Array.isArray(value) ? value : [value];
  const normalized = tags
    .filter((tag) => typeof tag === "string")
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => tag.length > 0);
  return Array.from(new Set(normalized));
}

function normalizeResonanceTags(value: unknown): string[] {
  const tags = normalizeTags(value);
  if (tags.length === 0) {
    return [];
  }
  return tags.filter((tag) => RESONANCE_TAG_SET.has(tag));
}

function normalizeResonanceMotifs(value: unknown): string[] {
  return normalizeTags(value);
}

function normalizeResonanceWeight(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return RESONANCE_WEIGHT_SET.has(normalized) ? normalized : null;
}

function normalizeResonanceIntensity(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  if (!Number.isFinite(parsed)) {
    return null;
  }
  const rounded = Math.round(parsed);
  if (!Number.isFinite(rounded)) {
    return null;
  }
  return Math.min(5, Math.max(1, rounded));
}

function normalizeResonanceState(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return RESONANCE_STATE_SET.has(normalized) ? normalized : null;
}

function serializeTagList(tags: string[]): string | null {
  if (!Array.isArray(tags) || tags.length === 0) {
    return null;
  }
  return tags.join("|");
}

const RESONANCE_WEIGHT_ORDER = new Map<string, number>([
  ["core", 4],
  ["pivot", 3],
  ["notable", 2],
  ["transient", 1],
]);

function pickHigherWeight(
  left?: string | null,
  right?: string | null
): string | null {
  const leftScore = left ? RESONANCE_WEIGHT_ORDER.get(left) ?? 0 : 0;
  const rightScore = right ? RESONANCE_WEIGHT_ORDER.get(right) ?? 0 : 0;
  return leftScore >= rightScore ? left ?? null : right ?? null;
}

function coerceMemoryItem(item: unknown): MemoryItem | null {
  if (typeof item === "string") {
    return { content: item, tags: [] };
  }
  if (!item || typeof item !== "object") {
    return null;
  }
  const record = item as Record<string, unknown>;
  const content =
    (typeof record.content === "string" && record.content) ||
    (typeof record.memory === "string" && record.memory) ||
    (typeof record.text === "string" && record.text) ||
    "";
  if (!content) {
    return null;
  }
  const tags = normalizeTags(record.tags ?? record.tag ?? record.type);
  const resonanceTags = normalizeResonanceTags(
    record.resonance_tags ?? record.resonanceTags ?? record.resonance
  );
  const resonanceWeight = normalizeResonanceWeight(
    record.resonance_weight ?? record.resonanceWeight ?? record.weight
  );
  const resonanceIntensity = normalizeResonanceIntensity(
    record.resonance_intensity ?? record.resonanceIntensity ?? record.intensity
  );
  const resonanceState = normalizeResonanceState(
    record.resonance_state ?? record.resonanceState ?? record.state
  );
  const resonanceMotifs = normalizeResonanceMotifs(
    record.resonance_motifs ?? record.resonanceMotifs ?? record.motifs ?? record.motif
  );
  return {
    content,
    tags,
    resonanceTags,
    resonanceWeight,
    resonanceIntensity,
    resonanceState,
    resonanceMotifs,
  };
}

function isDeprecatedMemoryItem(value: unknown): value is DeprecatedMemoryItem {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { id?: unknown }).id === "string"
  );
}

function formatWarsawDateTime(date = new Date()) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: WARSAW_TIMEZONE,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(date);
}

function getWarsawDateParts(date = new Date()): DateParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: WARSAW_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const map = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(map.get("year")),
    month: Number(map.get("month")),
    day: Number(map.get("day")),
  };
}

function addDays(parts: DateParts, days: number): DateParts {
  const base = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  base.setUTCDate(base.getUTCDate() + days);
  return {
    year: base.getUTCFullYear(),
    month: base.getUTCMonth() + 1,
    day: base.getUTCDate(),
  };
}

function formatDate(parts: DateParts) {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function parseTime(text: string): TimeParts | null {
  const timeMatch = text.match(/\b([01]?\d|2[0-3])[:.](\d{2})\b/);
  if (timeMatch) {
    return { hour: Number(timeMatch[1]), minute: Number(timeMatch[2]) };
  }

  const normalized = normalizeText(text);
  const prefixedMatch = normalized.match(
    /\b(?:o|at|ok|okolo|around|godz|godzina)\s*([01]?\d|2[0-3])(?:[:.](\d{2}))?\b/
  );
  if (prefixedMatch) {
    return {
      hour: Number(prefixedMatch[1]),
      minute: prefixedMatch[2] ? Number(prefixedMatch[2]) : 0,
    };
  }

  const ampmMatch = text.match(/\b(1[0-2]|0?[1-9])\s?(am|pm)\b/i);
  if (ampmMatch) {
    let hour = Number(ampmMatch[1]);
    const meridiem = ampmMatch[2].toLowerCase();
    if (meridiem === "pm" && hour < 12) {
      hour += 12;
    }
    if (meridiem === "am" && hour === 12) {
      hour = 0;
    }
    return { hour, minute: 0 };
  }

  if (/\b(poludnie|noon|midday)\b/.test(normalized)) {
    return { hour: 12, minute: 0 };
  }
  if (/\b(polnoc|midnight)\b/.test(normalized)) {
    return { hour: 0, minute: 0 };
  }
  if (/\b(po poludniu|popoludniu|afternoon)\b/.test(normalized)) {
    return { hour: 15, minute: 0 };
  }
  if (/\b(wieczorem|evening)\b/.test(normalized)) {
    return { hour: 19, minute: 0 };
  }
  if (/\b(rano|morning)\b/.test(normalized)) {
    return { hour: 9, minute: 0 };
  }
  if (/\b(noca|w nocy|night)\b/.test(normalized)) {
    return { hour: 21, minute: 0 };
  }

  return null;
}

function parseDate(text: string, baseDate: DateParts): DateParts | null {
  const normalized = normalizeText(text);
  if (/\bpojutrze\b/.test(normalized)) {
    return addDays(baseDate, 2);
  }
  if (/\b(jutro|tomorrow)\b/.test(normalized)) {
    return addDays(baseDate, 1);
  }
  if (/\b(dzisiaj|dzis|today)\b/.test(normalized)) {
    return baseDate;
  }

  const relativeMatch = normalized.match(
    /\b(?:in|za)\s+(\d+)\s+(day|days|week|weeks|dzien|dni|tydzien|tygodnie)\b/
  );
  if (relativeMatch) {
    const amount = Number(relativeMatch[1]);
    const unit = relativeMatch[2];
    if (Number.isFinite(amount) && amount > 0 && amount <= 30) {
      const multiplier =
        unit.startsWith("week") ||
        unit.startsWith("tydzien") ||
        unit.startsWith("tygodn")
          ? 7
          : 1;
      return addDays(baseDate, amount * multiplier);
    }
  }

  if (/\bza\s+tydzien\b/.test(normalized)) {
    return addDays(baseDate, 7);
  }

  const isoMatch = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoMatch) {
    return {
      year: Number(isoMatch[1]),
      month: Number(isoMatch[2]),
      day: Number(isoMatch[3]),
    };
  }

  const dmMatch = text.match(/\b(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\b/);
  if (dmMatch) {
    const day = Number(dmMatch[1]);
    const month = Number(dmMatch[2]);
    const yearRaw = dmMatch[3];
    let year = baseDate.year;
    if (yearRaw) {
      const yearNum = Number(yearRaw);
      year = yearNum < 100 ? 2000 + yearNum : yearNum;
    }
    return { year, month, day };
  }

  const monthMatch = normalized.match(MONTH_NAME_REGEX);
  if (monthMatch) {
    const day = Number(monthMatch[1]);
    const monthKey = monthMatch[2].toLowerCase();
    const month = MONTH_NAME_MAP[monthKey];
    if (month) {
      const year = monthMatch[3] ? Number(monthMatch[3]) : baseDate.year;
      return { year, month, day };
    }
  }

  const weekdayMap: Array<{ day: number; pattern: RegExp }> = [
    { day: 1, pattern: /\b(monday|mon|poniedzialek|pon)\b/ },
    { day: 2, pattern: /\b(tuesday|tue|tues|wtorek|wt)\b/ },
    { day: 3, pattern: /\b(wednesday|wed|sroda|sro)\b/ },
    { day: 4, pattern: /\b(thursday|thu|thurs|czwartek|czw)\b/ },
    { day: 5, pattern: /\b(friday|fri|piatek|pt)\b/ },
    { day: 6, pattern: /\b(saturday|sat|sobota|sb)\b/ },
    { day: 0, pattern: /\b(sunday|sun|niedziela|nd)\b/ },
  ];
  const forceNext = /\b(next|przyszly|przyszla|przyszlym)\b/.test(normalized);
  for (const entry of weekdayMap) {
    if (entry.pattern.test(normalized)) {
      const current = new Date(
        Date.UTC(baseDate.year, baseDate.month - 1, baseDate.day)
      ).getUTCDay();
      let delta = (entry.day - current + 7) % 7;
      if (delta === 0 && forceNext) {
        delta = 7;
      }
      return addDays(baseDate, delta);
    }
  }

  return null;
}

function buildEventMemory(text: string, baseDate: DateParts): EventMemory | null {
  const dateParts = parseDate(text, baseDate);
  if (!dateParts) {
    return null;
  }
  const normalized = normalizeText(text);
  const timeParts = parseTime(text);
  const hasEventKeyword = EVENT_KEYWORD_REGEX.test(normalized);
  const hasRelativeCue = /\b(tomorrow|today|next|jutro|dzis|dzisiaj|pojutrze|za)\b/.test(
    normalized
  );
  if (!hasEventKeyword && !timeParts && !hasRelativeCue) {
    return null;
  }
  const dateString = formatDate(dateParts);
  const timeString = timeParts ? `${pad2(timeParts.hour)}:${pad2(timeParts.minute)}` : "time TBD";
  const whenLabel = timeParts ? `${dateString} ${timeString}` : dateString;
  const content = `Event: ${text.trim()} (when: ${whenLabel} ${WARSAW_TIMEZONE})`;

  const eventTime = timeParts
    ? `${dateString}T${timeString}:00`
    : `${dateString}T00:00:00`;
  const expiresDate = addDays(dateParts, EVENT_MEMORY_TTL_DAYS);
  const expiresAt = `${formatDate(expiresDate)}T23:59:59`;

  return { content, eventTime, expiresAt };
}

function extractEventMemories(messages: MemoryMessage[], baseDate: DateParts) {
  const lastUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  if (!lastUserMessage) {
    return [];
  }

  const event = buildEventMemory(lastUserMessage.content, baseDate);
  return event ? [event] : [];
}

function sanitizeMessages(messages: MemoryMessage[]) {
  return messages
    .filter(
      (message) =>
        message &&
        (message.role === "user" || message.role === "assistant") &&
        typeof message.content === "string"
    )
    .map((message) => ({
      role: message.role,
      content: message.content.trim(),
      id: normalizeMessageId(message.id) ?? undefined,
    }))
    .filter((message) => message.content.length > 0);
}

function buildPrompt(
  messages: MemoryMessage[],
  candidates: { id: string; content: string }[],
  nowContext: string
) {
  const formattedMessages = messages
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n");
  const formattedCandidates =
    candidates.length > 0
      ? candidates.map((c) => `[ID: ${c.id}] ${c.content}`).join("\n")
      : "None";

  return [
    `Current date/time (Europe/Warsaw): ${nowContext}`,
    "Recent conversation (last messages):",
    formattedMessages,
    "",
    "Old candidate memories:",
    formattedCandidates,
    "",
    "Return a JSON array of new memory objects as specified in the system prompt.",
  ].join("\n");
}

function parseAgentResponse(raw: string): {
  new_memories: MemoryItem[];
  deprecated_memories: { id: string; reason?: string }[];
} {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { new_memories: [], deprecated_memories: [] };
  }

  const parseData = (value: unknown) => {
    if (!value || typeof value !== "object") {
      return { new_memories: [], deprecated_memories: [] };
    }
    const data = value as Record<string, unknown>;
    
    const new_memories = Array.isArray(data.new_memories)
      ? data.new_memories
          .map((item) => coerceMemoryItem(item))
          .filter((item): item is MemoryItem => Boolean(item))
      : [];
      
    const deprecated_memories = Array.isArray(data.deprecated_memories)
      ? data.deprecated_memories
          .filter((item): item is DeprecatedMemoryItem =>
            isDeprecatedMemoryItem(item)
          )
      : [];

    return { new_memories, deprecated_memories };
  };

  try {
    return parseData(JSON.parse(trimmed));
  } catch {
    // fallthrough to best-effort parsing
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return { new_memories: [], deprecated_memories: [] };
  }

  try {
    return parseData(JSON.parse(trimmed.slice(start, end + 1)));
  } catch {
    return { new_memories: [], deprecated_memories: [] };
  }
}

async function generateAgentQueries(
  messages: MemoryMessage[],
  apiKey?: string,
  appUrl?: string
): Promise<string[]> {
  const model = "google/gemini-2.5-flash-lite";
  const systemPrompt = `You are a memory optimization assistant.
Your goal is to generate search queries to find existing long-term memories that might overlap with, contradict, or already contain new facts from the recent conversation.

Analyze the user's messages and generate 3-5 specific search queries.
Focus on:
- Synonyms and semantic duplicates (e.g. "I run" -> search "exercise habits", "running").
- Existing preferences (e.g., if user says "I like tea", query for "drink preference", "coffee vs tea").
- Known facts (e.g., if user says "My age is 30", query for "user age", "birth year").

Output purely a JSON object: { "queries": ["query 1", "query 2"] }`;

  try {
    const response = await createChatCompletion({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        ...messages,
      ],
      temperature: 0.1,
      apiKey,
      appUrl,
    });

    if (!response.ok) return [];

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) return [];

    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start !== -1 && end !== -1) {
      const jsonStr = content.substring(start, end + 1);
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed.queries)) {
        return parsed.queries.filter((q: unknown) => typeof q === "string");
      }
    }
  } catch (error) {
    console.warn("Memory Agent: Failed to generate queries", error);
  }
  return [];
}

export async function runMemoryAgent({
  messages,
  apiKey,
  appUrl,
  conversationId,
}: MemoryAgentInput): Promise<MemoryAgentResult> {
  const historyWindow = memoryAgentConfig?.history_window ?? 20;
  const candidateCount = memoryAgentConfig?.candidate_count ?? 15;
  const memoryModel = memoryAgentConfig?.default_model ?? "deepseek/deepseek-v3.2";
  const temperature = memoryAgentConfig?.parameters?.temperature ?? 0.1;
  const embeddingModel =
    embeddingsConfig?.model ?? "google/gemini-embedding-001";

  const sanitized = sanitizeMessages(messages).slice(-historyWindow);
  if (sanitized.length === 0) {
    return { stored: 0, candidates: 0, newMemories: [] };
  }
  const normalizedConversationId = normalizeConversationId(conversationId);
  const sourceMessageIds = sanitized
    .map((message) => message.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  const sourceMessageIdsRaw =
    sourceMessageIds.length > 0 ? JSON.stringify(sourceMessageIds) : null;
  const sourceMessageStartId = sourceMessageIds[0] ?? null;
  const sourceMessageEndId =
    sourceMessageIds.length > 0
      ? sourceMessageIds[sourceMessageIds.length - 1]
      : null;
  const sourceMessageCount =
    sourceMessageIds.length > 0 ? sourceMessageIds.length : null;

  // Improved Candidate Fetching: Use Lite LLM to generate targeted queries
  let candidateMemories: { id: string; content: string }[] = [];
  try {
    const agentQueries = await generateAgentQueries(sanitized, apiKey, appUrl);
    
    // If LLM fails or returns empty, fallback to using the last user message
    if (agentQueries.length === 0) {
       const lastUser = sanitized.slice().reverse().find(m => m.role === "user");
       if (lastUser) agentQueries.push(lastUser.content);
    }

    if (agentQueries.length > 0) {
      const resultsArray = await Promise.all(
        agentQueries.map(async (query) => {
          const emb = await generateEmbedding(query, embeddingModel, apiKey);
          if (emb.length === 0) return null;
          return await queryVectors(emb, Math.ceil(candidateCount / 2));
        })
      );

      const seenDocs = new Map<string, string>(); // content -> id
      for (const res of resultsArray) {
        if (!res) continue;
        res.documents.forEach((doc, idx) => {
          if (typeof doc === "string" && doc.trim().length > 0) {
            const content = doc.trim();
            if (!seenDocs.has(content)) {
                seenDocs.set(content, res.ids[idx]);
            }
          }
        });
      }
      candidateMemories = Array.from(seenDocs.entries())
        .map(([content, id]) => ({ id, content }))
        .slice(0, candidateCount * 2);
    }
  } catch (error) {
    console.warn("Memory agent: unable to fetch candidates.", error);
  }

  const nowContext = formatWarsawDateTime();
  const baseDate = getWarsawDateParts();
  const prompt = buildPrompt(sanitized, candidateMemories, nowContext);

  const reasoning =
    memoryAgentConfig?.parameters?.reasoning === true
      ? { enabled: true }
      : undefined;

  let response: Response | undefined;
  let lastError: unknown;
  const maxRetries = 3;
  const fallbackModel = "google/gemini-3-flash-preview";

  // Retry loop for primary model
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      response = await createChatCompletion({
        model: memoryModel,
        messages: [
          { role: "system", content: MEMORY_AGENT_PROMPT },
          { role: "user", content: prompt },
        ],
        temperature,
        stream: false,
        reasoning,
        apiKey,
        appUrl,
      });

      if (response.ok) {
        break;
      } else {
        const text = await response.text();
        throw new Error(`HTTP ${response.status}: ${text}`);
      }
    } catch (error) {
      lastError = error;
      console.warn(
        `Memory agent: Attempt ${attempt + 1} with ${memoryModel} failed.`,
        error
      );
      if (attempt < maxRetries - 1) {
        // Exponential backoff: 1s, 2s, ...
        await new Promise((resolve) =>
          setTimeout(resolve, 1000 * Math.pow(2, attempt))
        );
      }
    }
  }

  // Fallback if primary failed
  if (!response || !response.ok) {
    console.warn(
      `Memory agent: Primary model ${memoryModel} failed. Switching to fallback ${fallbackModel}.`
    );
    try {
      response = await createChatCompletion({
        model: fallbackModel,
        messages: [
          { role: "system", content: MEMORY_AGENT_PROMPT },
          { role: "user", content: prompt },
        ],
        temperature,
        stream: false,
        reasoning: undefined,
        apiKey,
        appUrl,
      });
    } catch (error) {
      console.error(
        `Memory agent: Fallback model ${fallbackModel} also failed.`,
        error
      );
      throw lastError || error;
    }
  }

  if (!response || !response.ok) {
    const errorText = response ? await response.text() : "Unknown error";
    throw new Error(`Memory agent request failed: ${errorText}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const rawOutput = data.choices?.[0]?.message?.content ?? "";
  const { new_memories: parsedMemories, deprecated_memories: deprecatedMemories } = parseAgentResponse(rawOutput);

  // Handle Deprecations
  if (deprecatedMemories.length > 0) {
    const idsToDelete = deprecatedMemories.map(m => m.id);
    console.log(`Memory agent: Deprecating ${idsToDelete.length} old memories:`, idsToDelete);
    try {
      const { deleteVectors } = await import("./vector"); // Ensure deleteVectors is imported/available
      await deleteVectors(idsToDelete);
    } catch (error) {
      console.warn("Memory agent: Failed to delete deprecated memories.", error);
    }
  }

  const normalizedMemories = parsedMemories
    .map((memory) => ({
      content: memory.content.trim(),
      tags: normalizeTags(memory.tags),
      resonanceTags: normalizeResonanceTags(memory.resonanceTags),
      resonanceWeight:
        normalizeResonanceWeight(memory.resonanceWeight) ?? "transient",
      resonanceIntensity: normalizeResonanceIntensity(memory.resonanceIntensity),
      resonanceState: normalizeResonanceState(memory.resonanceState),
      resonanceMotifs: normalizeResonanceMotifs(memory.resonanceMotifs),
    }))
    .filter((memory) => memory.content.length > 0);

  const dedupedMemories = new Map<string, MemoryItem>();
  for (const memory of normalizedMemories) {
    const key = memory.content.toLowerCase();
    const existing = dedupedMemories.get(key);
    if (!existing) {
      dedupedMemories.set(key, memory);
      continue;
    }
    const mergedTags = Array.from(new Set([...existing.tags, ...memory.tags]));
    const mergedResonanceTags = Array.from(
      new Set([...(existing.resonanceTags ?? []), ...(memory.resonanceTags ?? [])])
    );
    const mergedMotifs = Array.from(
      new Set([...(existing.resonanceMotifs ?? []), ...(memory.resonanceMotifs ?? [])])
    );
    const mergedWeight = pickHigherWeight(
      existing.resonanceWeight ?? null,
      memory.resonanceWeight ?? null
    );
    const mergedIntensity = Math.max(
      existing.resonanceIntensity ?? 0,
      memory.resonanceIntensity ?? 0
    );
    const mergedState = existing.resonanceState ?? memory.resonanceState ?? null;
    dedupedMemories.set(key, {
      content: existing.content,
      tags: mergedTags,
      resonanceTags: mergedResonanceTags,
      resonanceWeight: mergedWeight,
      resonanceIntensity: mergedIntensity || null,
      resonanceState: mergedState,
      resonanceMotifs: mergedMotifs,
    });
  }
  const uniqueMemories = Array.from(dedupedMemories.values());
  const candidateSet = new Set(
    candidateMemories.map((c) => c.content.toLowerCase())
  );
  const newMemories = uniqueMemories.filter(
    (memory) => !candidateSet.has(memory.content.toLowerCase())
  );
  const eventMemories = extractEventMemories(sanitized, baseDate);

  const createdAt = new Date().toISOString();
  const memoryInserts: Array<{ content: string; metadata: MemoryMetadata }> = [];

  const VALID_TYPES = new Set(["profile", "work", "social", "health", "media", "event", "fact"]);

  newMemories.forEach((memory) => {
    // Determine type from the first valid tag, defaulting to "fact"
    const firstTag = memory.tags.find(t => VALID_TYPES.has(t));
    const type = firstTag || "fact";
    const tagsFlat = serializeTagList(memory.tags);
    const resonanceTagsFlat = serializeTagList(memory.resonanceTags ?? []);
    const resonanceMotifsFlat = serializeTagList(memory.resonanceMotifs ?? []);
    const resonancePrimary =
      memory.resonanceTags && memory.resonanceTags.length > 0
        ? memory.resonanceTags[0]
        : null;

    memoryInserts.push({
      content: memory.content,
      metadata: {
        source: "memory_agent",
        created_at: createdAt,
        source_at: createdAt,
        model: memoryModel,
        type,
        tags_flat: tagsFlat,
        resonance_tags_flat: resonanceTagsFlat,
        resonance_motifs_flat: resonanceMotifsFlat,
        resonance_primary: resonancePrimary,
        resonance_weight: memory.resonanceWeight ?? null,
        resonance_intensity: memory.resonanceIntensity ?? null,
        resonance_state: memory.resonanceState ?? null,
        temporal_window_min: TEMPORAL_WINDOW_MIN,
        conversation_id: normalizedConversationId,
        source_message_ids: sourceMessageIdsRaw,
        source_message_start_id: sourceMessageStartId,
        source_message_end_id: sourceMessageEndId,
        source_message_count: sourceMessageCount,
      },
    });
  });

  const existingSet = new Set(
    [
      ...candidateMemories.map(c => c.content),
      ...newMemories.map((memory) => memory.content),
    ].map((memory) => memory.toLowerCase())
  );
  eventMemories.forEach((eventMemory) => {
    const key = eventMemory.content.toLowerCase();
    if (existingSet.has(key)) {
      return;
    }
    memoryInserts.push({
      content: eventMemory.content,
      metadata: {
        source: "event_fallback",
        created_at: createdAt,
        source_at: createdAt,
        model: memoryModel,
        type: "event",
        tags_flat: "event",
        event_time: eventMemory.eventTime ?? null,
        event_timezone: WARSAW_TIMEZONE,
        expires_at: eventMemory.expiresAt ?? null,
        temporal_window_min: TEMPORAL_WINDOW_MIN,
        conversation_id: normalizedConversationId,
        source_message_ids: sourceMessageIdsRaw,
        source_message_start_id: sourceMessageStartId,
        source_message_end_id: sourceMessageEndId,
        source_message_count: sourceMessageCount,
      },
    });
  });

  if (memoryInserts.length === 0) {
    return {
      stored: 0,
      candidates: candidateMemories.length,
      newMemories: [],
    };
  }

  const dedupedInserts: Array<{ content: string; metadata: MemoryMetadata }> = [];
  const seen = new Set<string>();
  
  // Create a normalized set of candidate memories for substring checking
  const normalizedCandidates = candidateMemories.map(c => c.content.toLowerCase().trim());

  for (const insert of memoryInserts) {
    const key = insert.content.toLowerCase().trim();
    if (seen.has(key)) {
      continue;
    }
    
    // Substring Deduplication: Check if this new memory is just a substring of an existing one (or vice versa)
    // This catches "I like coffee" vs "I really like coffee" without needing vectors
    const isSubstringDuplicate = normalizedCandidates.some(candidate => {
       return candidate.includes(key) || key.includes(candidate);
    });

    if (isSubstringDuplicate) {
      console.log(`Memory agent: Skipping substring duplicate: "${insert.content}"`);
      continue;
    }

    seen.add(key);
    dedupedInserts.push(insert);
  }

  const embeddingResults = await Promise.allSettled(
    dedupedInserts.map((memory) =>
      generateEmbedding(memory.content, embeddingModel, apiKey)
    )
  );

  const records: VectorRecord[] = [];
  for (let i = 0; i < embeddingResults.length; i++) {
    const result = embeddingResults[i];
    if (result.status !== "fulfilled" || result.value.length === 0) {
      continue;
    }

    const embedding = result.value;
    const content = dedupedInserts[i].content;

    // Semantic Deduplication: Check if a very similar memory already exists
    try {
      const existing = await queryVectors(embedding, 1);
      const topDistance = existing.distances?.[0];
      // Threshold: 0.35 allows for semantic variation (rephrasing) while catching duplicates
      // 0.1 was too strict (near-identical only).
      if (typeof topDistance === "number" && topDistance < 0.35) {
        console.log(`Memory agent: Skipping near-duplicate memory: "${content}" (distance: ${topDistance})`);
        continue;
      }
    } catch (error) {
      console.warn("Memory agent: Deduplication check failed.", error);
    }

    records.push({
      id: randomUUID(),
      embedding: embedding,
      document: content,
      metadata: dedupedInserts[i].metadata,
    });
  }

  if (records.length > 0) {
    await upsertVectors(records);
  }

  return {
    stored: records.length,
    candidates: candidateMemories.length,
    newMemories: dedupedInserts.map((insert) => insert.content),
  };
}
