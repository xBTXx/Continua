import { truncateText } from "./memoryHelpers";

const MAX_TOOL_CONTEXT_LENGTH = parseEnvNumber(
  process.env.CHAT_TOOL_CONTEXT_MAX_CHARS,
  12_000,
  1_000,
  60_000
);
const MIN_TOOL_CONTEXT_LENGTH = parseEnvNumber(
  process.env.CHAT_TOOL_CONTEXT_MIN_CHARS,
  1_500,
  500,
  MAX_TOOL_CONTEXT_LENGTH
);
const MAX_TOOL_FIELD_LENGTH = parseEnvNumber(
  process.env.CHAT_TOOL_FIELD_MAX_CHARS,
  2_000,
  500,
  20_000
);
const MAX_TOOL_ITEM_TEXT_LENGTH = parseEnvNumber(
  process.env.CHAT_TOOL_ITEM_TEXT_MAX_CHARS,
  4_000,
  1_000,
  30_000
);
const MAX_TOOL_CONTENT_ITEMS = parseEnvNumber(
  process.env.CHAT_TOOL_CONTENT_ITEM_LIMIT,
  8,
  1,
  40
);
const MAX_TOOL_PRUNE_DEPTH = parseEnvNumber(
  process.env.CHAT_TOOL_PRUNE_DEPTH,
  4,
  1,
  10
);

function parseEnvNumber(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
) {
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[tool result is not serializable]";
  }
}

function resolveToolContextLength(preferredLength?: number) {
  if (typeof preferredLength !== "number" || !Number.isFinite(preferredLength)) {
    return MAX_TOOL_CONTEXT_LENGTH;
  }
  return Math.min(
    MAX_TOOL_CONTEXT_LENGTH,
    Math.max(MIN_TOOL_CONTEXT_LENGTH, Math.floor(preferredLength))
  );
}

function pruneToolResultForContext(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string") {
      return truncateText(value, MAX_TOOL_FIELD_LENGTH);
    }
    return value;
  }

  if (depth >= MAX_TOOL_PRUNE_DEPTH) {
    return "[tool result omitted for depth]";
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_TOOL_CONTENT_ITEMS)
      .map((item) => pruneToolResultForContext(item, depth + 1));
  }

  const pruned: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
    if (key === "content" && Array.isArray(field)) {
      pruned[key] = field
        .slice(0, MAX_TOOL_CONTENT_ITEMS)
        .map(pruneToolContentItemForContext);
      continue;
    }

    if (typeof field === "string") {
      pruned[key] = truncateText(field, MAX_TOOL_FIELD_LENGTH);
    } else if (Array.isArray(field)) {
      pruned[key] = field
        .slice(0, MAX_TOOL_CONTENT_ITEMS)
        .map((item) => pruneToolResultForContext(item, depth + 1));
    } else if (typeof field === "object" && field !== null) {
      pruned[key] = pruneToolResultForContext(field, depth + 1);
    } else {
      pruned[key] = field;
    }
  }

  return pruned;
}

function pruneToolContentItemForContext(item: unknown) {
  if (!item || typeof item !== "object") {
    return item;
  }

  const pruned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
    if (key === "text" && typeof value === "string") {
      pruned[key] = truncateText(value, MAX_TOOL_ITEM_TEXT_LENGTH);
    } else if (typeof value === "string") {
      pruned[key] = truncateText(value, MAX_TOOL_FIELD_LENGTH);
    } else if (Array.isArray(value)) {
      pruned[key] = value
        .slice(0, MAX_TOOL_CONTENT_ITEMS)
        .map((entry) => pruneToolResultForContext(entry, 1));
    } else if (typeof value === "object" && value !== null) {
      pruned[key] = pruneToolResultForContext(value, 1);
    } else {
      pruned[key] = value;
    }
  }

  return pruned;
}

export function prepareToolContextContent(
  result: unknown,
  preferredLength?: number
): string {
  const contextLength = resolveToolContextLength(preferredLength);
  if (result === null || typeof result === "undefined") {
    return "";
  }

  if (typeof result === "string") {
    return truncateText(result, contextLength);
  }

  const pruned = pruneToolResultForContext(result);
  const serialized = safeStringify(pruned);
  return truncateText(serialized, contextLength);
}
