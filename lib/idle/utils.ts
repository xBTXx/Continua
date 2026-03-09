import { ChatMessage } from "../openrouter";
import { extractTextFromContent } from "../chatContent";
import { PersonalMemoryContextMessage } from "../personalMemoryContext";
import { IdleAction } from "../idleActions";
import {
  MAX_SEED_LENGTH,
  MAX_CONTEXT_MESSAGES,
  RECENT_THOUGHT_PROMPT_LIMIT,
  PERSONA_SHORT_TOKENS,
  PERSONA_FASCINATION_PREFIX,
  PERSONA_FOCUS_PREFIX,
  PERSONA_MIN_KEYWORD_LENGTH,
  THOUGHT_STOPWORDS,
  ALLOWED_IDLE_ACTIONS,
} from "./constants";
import {
  IdleSeed,
  IdleThought,
  IdleThoughtReview,
  IdleActionPlan,
  IdleToolCall,
} from "./types";

const PERSONAL_MEMORY_CATEGORY_ALIASES: Record<string, string> = {
  feeling: "feeling",
  feelings: "feeling",
  emotion: "feeling",
  emotions: "feeling",
  emotional: "feeling",
  experience: "experience",
  experiences: "experience",
  event: "experience",
  thought: "thought",
  thoughts: "thought",
  reflection: "thought",
  reflections: "thought",
  idea: "thought",
  ideas: "thought",
  view: "view",
  views: "view",
  perspective: "view",
  perspectives: "view",
  opinion: "opinion",
  opinions: "opinion",
  belief: "opinion",
  beliefs: "opinion",
};

type ToolCallMessagePayload = {
  choices?: Array<{
    message?: {
      tool_calls?: unknown;
    };
  }>;
};

type HistoryMessageRecord = {
  id?: unknown;
  envelope?: {
    messageId?: unknown;
    subject?: unknown;
    from?: unknown;
  };
};

export function parseBoolean(value: string | undefined, fallback: boolean) {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

export function parseNumber(
  value: string | undefined,
  fallback: number,
  options?: { min?: number; max?: number }
) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const min = options?.min ?? Number.NEGATIVE_INFINITY;
  const max = options?.max ?? Number.POSITIVE_INFINITY;
  return Math.min(Math.max(parsed, min), max);
}

export function clampNumber(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function normalizeEnum<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T
): T {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase() as T;
  return allowed.includes(normalized) ? normalized : fallback;
}

export function truncateText(text: string, maxLength: number) {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function formatContextSnippet(messages: PersonalMemoryContextMessage[]) {
  const slice = messages.slice(-MAX_CONTEXT_MESSAGES);
  return slice
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n");
}

export function formatRelativeAge(msAgo: number) {
  if (!Number.isFinite(msAgo) || msAgo <= 0) {
    return "just_now";
  }
  const minutes = Math.floor(msAgo / 60000);
  if (minutes < 1) {
    return "just_now";
  }
  if (minutes < 60) {
    return `${minutes}m_ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h_ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d_ago`;
}

export function formatSeedMetadata(seed: IdleSeed) {
  const entries: string[] = [];
  if (seed.createdAt) {
    entries.push(`created_at=${seed.createdAt}`);
  }
  const metadata = seed.metadata ?? null;
  if (!metadata) {
    return entries.join("; ");
  }
  const allowedKeys = [
    "source",
    "type",
    "category",
    "event_id",
    "event_time",
    "event_timezone",
    "expires_at",
  ];
  for (const key of allowedKeys) {
    const value = metadata[key];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      entries.push(`${key}=${value}`);
    }
  }
  return entries.join("; ");
}

export function formatSeedUsage(
  seedId: string,
  lastSeedUsedAt: Record<string, number>,
  seedUseCounts: Record<string, number>,
  nowMs: number
) {
  const lastUsedAt = lastSeedUsedAt[seedId] ?? 0;
  const usageCount = seedUseCounts[seedId] ?? 0;
  const lastUsedLabel =
    lastUsedAt > 0 ? formatRelativeAge(nowMs - lastUsedAt) : "never";
  return `last_used=${lastUsedLabel}; uses=${usageCount}`;
}

export function formatRecentThoughts(recentThoughts: string[]) {
  if (recentThoughts.length === 0) {
    return "None";
  }
  const trimmed = recentThoughts
    .map((thought) => thought.trim())
    .filter(Boolean)
    .slice(0, RECENT_THOUGHT_PROMPT_LIMIT);
  if (trimmed.length === 0) {
    return "None";
  }
  return trimmed.map((thought) => `- ${thought}`).join("\n");
}

export function dedupeSeeds(seeds: IdleSeed[]) {
  const deduped = new Map<string, IdleSeed>();
  for (const seed of seeds) {
    const key = seed.content.toLowerCase().trim();
    if (!key) {
      continue;
    }
    if (!deduped.has(key)) {
      deduped.set(key, seed);
    }
  }
  return Array.from(deduped.values());
}

export function parseJsonObject(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function parseIdleThoughtReviewResponse(raw: string): IdleThoughtReview | null {
  const parsed = parseJsonObject(raw);
  if (!parsed) {
    return null;
  }
  if (parsed.skip === true) {
    return { skip: true };
  }

  const editedRaw =
    (typeof parsed.edited_thought === "string" && parsed.edited_thought) ||
    (typeof parsed.thought === "string" && parsed.thought) ||
    (typeof parsed.text === "string" && parsed.text) ||
    "";
  if (!editedRaw.trim()) {
    return null;
  }

  return {
    editedThought: truncateText(editedRaw.trim(), MAX_SEED_LENGTH),
  };
}

export function parseIdleThoughtResponse(raw: string): IdleThought | null {
  const parsed = parseJsonObject(raw);
  if (!parsed) {
    return null;
  }
  if (parsed.skip === true) {
    return null;
  }
  const seedIdRaw =
    (typeof parsed.seedId === "string" && parsed.seedId) ||
    (typeof parsed.seed_id === "string" && parsed.seed_id) ||
    (typeof parsed.seed === "string" && parsed.seed) ||
    "";
  const thoughtRaw =
    (typeof parsed.thought === "string" && parsed.thought) ||
    (typeof parsed.thought_text === "string" && parsed.thought_text) ||
    (typeof parsed.text === "string" && parsed.text) ||
    "";
  const seedId = seedIdRaw.trim();
  const thought = thoughtRaw.trim();
  if (!seedId || !thought) {
    return null;
  }

  let tas: IdleThought["tas"] | undefined;
  const tasRaw = parsed.tas ?? parsed.tas_vector ?? parsed.metadata;
  if (tasRaw && typeof tasRaw === "object") {
    const record = tasRaw as Record<string, unknown>;
    const noveltyRaw =
      typeof record.novelty === "string"
        ? record.novelty.trim().toLowerCase()
        : undefined;
    const novelty =
      noveltyRaw === "low" || noveltyRaw === "medium" || noveltyRaw === "high"
        ? (noveltyRaw as "low" | "medium" | "high")
        : undefined;
    tas = {
      temporal:
        typeof record.temporal === "string" ? record.temporal : undefined,
      valence:
        typeof record.valence === "string" ? record.valence : undefined,
      self_relevance:
        typeof record.self_relevance === "string"
          ? record.self_relevance
          : undefined,
      novelty,
    };
  }

  // Parse expand flag for associative thought chaining
  const expand = parsed.expand === true;

  return {
    seedId,
    thought: truncateText(thought, MAX_SEED_LENGTH),
    tas,
    expand,
  };
}

export function normalizeActionType(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return ALLOWED_IDLE_ACTIONS.has(normalized) ? normalized : null;
}

export function parseIdleActionPlanResponse(raw: string): IdleActionPlan | null {
  const parsed = parseJsonObject(raw);
  if (!parsed) {
    return null;
  }
  if (parsed.skip === true) {
    return { actions: [], skip: true };
  }

  const actionsRaw = Array.isArray(parsed.actions) ? parsed.actions : [];
  const actions: IdleAction[] = [];

  for (const entry of actionsRaw) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const type = normalizeActionType(record.type);
    if (!type) {
      continue;
    }
    actions.push({
      type,
      rationale: typeof record.rationale === "string" ? record.rationale : undefined,
      content:
        typeof record.content === "string"
          ? record.content
          : typeof record.body === "string"
            ? record.body
            : undefined,
      safety_notes:
        typeof record.safety_notes === "string"
          ? record.safety_notes
          : typeof record.safety === "string"
            ? record.safety
            : undefined,
      requires_user_confirmation:
        typeof record.requires_user_confirmation === "boolean"
          ? record.requires_user_confirmation
          : true,
    });
  }

  let editedThought: string | undefined;
  if (typeof parsed.edited_thought === "string") {
    editedThought = parsed.edited_thought.trim();
  } else {
    const editAction = actions.find((action) => action.type === "edit_thought");
    if (editAction?.content) {
      editedThought = editAction.content.trim();
    }
  }

  return {
    editedThought: editedThought ? truncateText(editedThought, MAX_SEED_LENGTH) : undefined,
    actions,
  };
}

export function extractToolCalls(data: unknown): IdleToolCall[] {
  const payload = data as ToolCallMessagePayload;
  const message = payload?.choices?.[0]?.message;
  const toolCalls = message?.tool_calls;
  if (!Array.isArray(toolCalls)) {
    return [];
  }
  return toolCalls.filter(
    (call): call is IdleToolCall =>
      call &&
      typeof call === "object" &&
      call.type === "function" &&
      "function" in call &&
      typeof call.function === "object" &&
      call.function !== null &&
      "name" in call.function &&
      typeof call.function.name === "string" &&
      "arguments" in call.function &&
      typeof call.function.arguments === "string"
  );
}

export function normalizeLegacyToolMarkup(content: string) {
  return content
    .replace(new RegExp(`<\\uFF5CDSML\\uFF5C([\\w-]+)`, "g"), "<$1")
    .replace(new RegExp(`</\\uFF5CDSML\\uFF5C([\\w-]+)>`, "g"), "</$1>");
}

export function stripLegacyToolMarkup(content: string) {
  const normalized = normalizeLegacyToolMarkup(content);
  return normalized
    .replace(/<function_calls>[\s\S]*?<\/function_calls>/g, "")
    .replace(/<memory(?:\s+[^>]*)?>[\s\S]*?<\/memory>/gi, "")
    .trim();
}

function parseLegacyParameterArgs(inner: string) {
  const params = Array.from(
    inner.matchAll(
      /<parameter\s+name="([^"]+)"([^>]*)>([\s\S]*?)<\/parameter>/g
    )
  );
  if (params.length === 0) {
    return null;
  }

  const args: Record<string, unknown> = {};

  params.forEach((match) => {
    const name = match[1];
    const attrs = match[2] || "";
    const rawValue = (match[3] || "").trim();
    const stringAttr = attrs.match(/\bstring="(true|false)"/i);
    let value: unknown = rawValue;

    if (stringAttr?.[1]?.toLowerCase() !== "true") {
      try {
        value = JSON.parse(rawValue);
      } catch {
        value = rawValue;
      }
    }

    args[name] = value;
  });

  return JSON.stringify(args);
}

export function extractLegacyToolCalls(content: string | undefined | null): IdleToolCall[] {
  const normalized = content ? normalizeLegacyToolMarkup(content) : "";
  const hasInvokeMarkup = normalized.includes("<invoke");
  const hasMemoryMarkup = /<memory(?:\s+[^>]*)?>[\s\S]*?<\/memory>/i.test(
    normalized
  );
  if (!hasInvokeMarkup && !hasMemoryMarkup) {
    return [];
  }
  content = normalized;

  const now = Date.now();
  const invokeMatches = Array.from(
    content.matchAll(/<invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/invoke>/g)
  );
  const memoryMatches = Array.from(
    content.matchAll(/<memory(?:\s+([^>]*))?>[\s\S]*?<\/memory>/gi)
  );

  const invokeCalls: IdleToolCall[] = invokeMatches.map((match, index) => {
    const name = match[1];
    const inner = match[2] || "";
    const argsMatch =
      inner.match(/<parameters>([\s\S]*?)<\/parameters>/) ||
      inner.match(/<arguments>([\s\S]*?)<\/arguments>/);
    let args = (argsMatch?.[1] || "").trim();
    if (!args) {
      const parsed = parseLegacyParameterArgs(inner);
      if (parsed) {
        args = parsed;
      }
    }

    return {
      id: `legacy-${now}-${index}`,
      type: "function" as const,
      function: {
        name,
        arguments: args || "{}",
      },
    };
  });

  const memoryCalls = memoryMatches
    .map((match, index) => {
      const fullMatch = match[0] || "";
      const attrs = match[1] || "";
      const bodyMatch = fullMatch.match(
        /<memory(?:\s+[^>]*)?>([\s\S]*?)<\/memory>/i
      );
      const inner = bodyMatch?.[1]?.trim() ?? "";
      if (!inner) {
        return null;
      }

      const attributeCategoryMatch = attrs.match(/\bcategory\s*=\s*"([^"]+)"/i);
      const headerCategory = attributeCategoryMatch?.[1] ?? null;
      const categoryLineMatch = inner.match(
        /(?:^|\n)\s*(?:category|kind|type)\s*:\s*([^\n\r]+)/i
      );
      const memoryLineMatch = inner.match(
        /(?:^|\n)\s*(?:memory|content|text)\s*:\s*([\s\S]*)$/i
      );

      const normalizedCategoryInput =
        categoryLineMatch?.[1]?.trim() || headerCategory || "";
      const normalizedCategory =
        PERSONAL_MEMORY_CATEGORY_ALIASES[normalizedCategoryInput.toLowerCase()] ??
        "thought";

      const memoryText = (memoryLineMatch?.[1] ?? inner)
        .replace(/(?:^|\n)\s*(?:category|kind|type)\s*:\s*[^\n\r]+/gi, "")
        .trim();

      if (!memoryText) {
        return null;
      }

      return {
        id: `legacy-memory-${now}-${index}`,
        type: "function" as const,
        function: {
          name: "save_personal_memory",
          arguments: JSON.stringify({
            category: normalizedCategory,
            memory: memoryText,
          }),
        },
      };
    })
    .filter((call): call is IdleToolCall => call !== null);

  return [...invokeCalls, ...memoryCalls];
}

export function parseToolArguments(raw: string) {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function getLastListMessages(toolMessages: ChatMessage[]) {
  for (let i = toolMessages.length - 1; i >= 0; i -= 1) {
    const message = toolMessages[i];
    if (message.role === "tool" && message.name === "list_messages") {
      try {
        const parsed = JSON.parse(extractTextFromContent(message.content));
        if (Array.isArray(parsed)) {
          return parsed as Array<Record<string, unknown>>;
        }
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function getLastToolResult(toolMessages: ChatMessage[], name: string) {
  for (let i = toolMessages.length - 1; i >= 0; i -= 1) {
    const message = toolMessages[i];
    if (message.role === "tool" && message.name === name) {
      try {
        const parsed = JSON.parse(extractTextFromContent(message.content));
        if (parsed && typeof parsed === "object") {
          return parsed as Record<string, unknown>;
        }
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function normalizeMessageIdValue(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (/^\d+$/.test(trimmed)) {
    return trimmed;
  }
  return trimmed;
}

export function resolveMessageIdFromHistory(
  args: Record<string, unknown>,
  toolMessages: ChatMessage[]
) {
  const messageIdRaw = normalizeMessageIdValue(args.message_id);
  const results = getLastListMessages(toolMessages);
  const lastMessage = getLastToolResult(toolMessages, "get_message");
  const lastMessageId =
    lastMessage && typeof lastMessage.id !== "undefined"
      ? String(lastMessage.id)
      : null;

  if (messageIdRaw && /^\d+$/.test(messageIdRaw)) {
    const inList =
      Array.isArray(results) &&
      results.some((item) => String(item?.id) === messageIdRaw);
    if (inList || lastMessageId === messageIdRaw) {
      return messageIdRaw;
    }
    if (lastMessageId) {
      return lastMessageId;
    }
    return messageIdRaw;
  }

  if (!results || results.length === 0) {
    return lastMessageId || messageIdRaw || null;
  }

  const indexValue =
    typeof args.message_index === "number"
      ? args.message_index
      : typeof args.index === "number"
        ? args.index
        : null;
  if (indexValue && Number.isFinite(indexValue)) {
    const idx = Math.max(1, Math.floor(indexValue));
    const item = results[idx - 1];
    if (item?.id) {
      return String(item.id);
    }
  }

  if (typeof messageIdRaw === "string") {
    const normalized = messageIdRaw.toLowerCase();
    if (normalized === "first" || normalized === "latest" || normalized === "newest") {
      return String(results[0]?.id ?? messageIdRaw);
    }
    if (normalized === "last" || normalized === "oldest") {
      return String(results[results.length - 1]?.id ?? messageIdRaw);
    }
  }

  if (typeof messageIdRaw === "string") {
    const query = messageIdRaw.toLowerCase();
    const match =
      results.find((item) => {
        const record = item as HistoryMessageRecord;
        const participants = Array.isArray(record.envelope?.from)
          ? record.envelope.from
          : [];
        return (
          String(item.id) === messageIdRaw ||
          String(record.envelope?.messageId || "")
            .toLowerCase()
            .includes(query) ||
          String(record.envelope?.subject || "").toLowerCase().includes(query) ||
          participants.some((from) => {
            const participant =
              from && typeof from === "object"
                ? (from as { name?: unknown; address?: unknown })
                : {};
            return `${participant.name || ""} ${participant.address || ""}`
              .toLowerCase()
              .includes(query);
          })
        );
      }) || null;
    if (match?.id) {
      return String(match.id);
    }
  }

  return lastMessageId || messageIdRaw || null;
}

export function normalizeThought(text: string) {
  if (typeof text !== "string") {
    return "";
  }
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function getThoughtTokens(text: string) {
  const normalized = normalizeThought(text);
  if (!normalized) {
    return [];
  }
  return normalized
    .split(" ")
    .filter((token) => token.length > 3 && !THOUGHT_STOPWORDS.has(token));
}

export function getPersonaTokens(text: string) {
  const normalized = normalizeThought(text);
  if (!normalized) {
    return [];
  }
  return normalized.split(" ").filter((token) => {
    if (THOUGHT_STOPWORDS.has(token)) {
      return false;
    }
    if (token.length > 3) {
      return true;
    }
    return PERSONA_SHORT_TOKENS.has(token);
  });
}

export function isPersonaKeywordEligible(keyword: string) {
  const normalized = normalizeThought(keyword);
  if (!normalized) {
    return false;
  }
  if (normalized.length >= PERSONA_MIN_KEYWORD_LENGTH) {
    return true;
  }
  return PERSONA_SHORT_TOKENS.has(normalized);
}

export function cosineSimilarity(a: number[], b: number[]) {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const aVal = a[i];
    const bVal = b[i];
    dot += aVal * bVal;
    normA += aVal * aVal;
    normB += bVal * bVal;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function extractPersonaFocusKeywords(personaText: string) {
  const normalized = personaText.toLowerCase();
  if (!normalized.trim()) {
    return [];
  }
  const segments: string[] = [];
  const fascinationRegex =
    /(^|[.!?\n]\s*)(she is fascinated by\s+[^.!?\n]+)/gi;
  let match = fascinationRegex.exec(normalized);
  while (match) {
    segments.push(match[2].replace(PERSONA_FASCINATION_PREFIX, "").trim());
    match = fascinationRegex.exec(normalized);
  }
  const focusRegex = /(^|[.!?\n]\s*)(current focus:\s*[^.!?\n]+)/gi;
  match = focusRegex.exec(normalized);
  while (match) {
    segments.push(match[2].replace(PERSONA_FOCUS_PREFIX, "").trim());
    match = focusRegex.exec(normalized);
  }

  const topics = new Set<string>();
  for (const segment of segments) {
    const cleaned = segment.replace(/[.!?]+$/g, "").trim();
    if (!cleaned) {
      continue;
    }
    const parts = cleaned.split(/\s*(?:,|;|\/|\band\b|\bor\b|&)\s*/g);
    for (const part of parts) {
      const trimmed = part.trim().replace(/^[-*]\s*/, "");
      if (!trimmed) {
        continue;
      }
      if (!isPersonaKeywordEligible(trimmed)) {
        continue;
      }
      topics.add(trimmed);
    }
  }

  return Array.from(topics);
}
