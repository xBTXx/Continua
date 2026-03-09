import type { ChatContentPart } from "@/types/chat";
import { extractTextFromContent } from "../chatContent";
import type { MemorySnippet } from "./types";

export function estimateTokens(text: string | ChatContentPart[]) {
  const normalized =
    typeof text === "string" ? text : extractTextFromContent(text);
  return Math.ceil(normalized.trim().length / 4);
}

export function truncateText(text: string, maxLength: number) {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function formatMemoryDate(raw?: string) {
  if (!raw) {
    return null;
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return raw;
  }
  return `${date.toISOString().replace("T", " ").replace("Z", " UTC")}`;
}

export function normalizeMetadataString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

export function normalizeMemoryId(value: unknown) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizeMessageId(value: unknown) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function parseMessageIdList(value: unknown): string[] | undefined {
  if (!value) {
    return undefined;
  }
  if (Array.isArray(value)) {
    const items = value
      .map((entry) => normalizeMessageId(entry))
      .filter((entry): entry is string => typeof entry === "string");
    return items.length > 0 ? items : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const items = parsed
          .map((entry) => normalizeMessageId(entry))
          .filter((entry): entry is string => typeof entry === "string");
        return items.length > 0 ? items : undefined;
      }
    } catch {
      // Fall back to splitting below.
    }
    const split = trimmed.split(/[|,]/);
    const items = split
      .map((entry) => normalizeMessageId(entry))
      .filter((entry): entry is string => typeof entry === "string");
    return items.length > 0 ? items : undefined;
  }
  return undefined;
}

export function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

export function normalizeTagField(value: unknown) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed ? trimmed : undefined;
}

export function normalizeMetadataNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function buildMemorySnippet(
  doc: string,
  metadata: Record<string, unknown> | null,
  id?: string
): MemorySnippet {
  const createdAt = normalizeMetadataString(metadata?.created_at);
  const sourceAt = normalizeMetadataString(metadata?.source_at);
  const sourceMessageIds = parseMessageIdList(metadata?.source_message_ids);
  return {
    id: normalizeMemoryId(id),
    content: doc,
    createdAt,
    sourceAt,
    conversationId: normalizeMetadataString(metadata?.conversation_id),
    sourceMessageIds,
    sourceMessageStartId: normalizeMessageId(metadata?.source_message_start_id),
    sourceMessageEndId: normalizeMessageId(metadata?.source_message_end_id),
    sourceMessageCount: normalizeMetadataNumber(metadata?.source_message_count),
    resonancePrimary: normalizeTagField(metadata?.resonance_primary),
    resonanceTagsFlat: normalizeTagField(metadata?.resonance_tags_flat),
    resonanceWeight: normalizeTagField(metadata?.resonance_weight),
    resonanceIntensity: normalizeMetadataNumber(metadata?.resonance_intensity),
    resonanceState: normalizeTagField(metadata?.resonance_state),
  };
}

export function parseTagList(raw?: string) {
  if (!raw) {
    return [];
  }
  return raw
    .split("|")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

export function resolveAnchorTime(memory: MemorySnippet) {
  return memory.sourceAt ?? memory.createdAt ?? null;
}
