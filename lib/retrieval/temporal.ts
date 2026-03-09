import { listVectors } from "../vector";
import {
  TEMPORAL_ANCHOR_LIMIT,
  TEMPORAL_RESULT_LIMIT,
  TEMPORAL_WINDOW_MINUTES,
} from "./config";
import { buildMemorySnippet, resolveAnchorTime } from "./helpers";
import type { MemorySnippet } from "./types";

type TemporalWindow = {
  start: string;
  end: string;
  field: "source_at" | "created_at";
  conversationId?: string;
};

const TEMPORAL_FETCH_BATCH = Math.max(TEMPORAL_RESULT_LIMIT * 4, 20);
const TEMPORAL_MAX_SCAN = 500;

function normalizeIso(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
}

function buildTemporalWindow(
  anchorIso: string,
  minutes: number,
  field: "source_at" | "created_at",
  conversationId?: string
): TemporalWindow | null {
  const parsedAnchor = normalizeIso(anchorIso);
  if (!parsedAnchor) {
    return null;
  }
  const anchorDate = new Date(parsedAnchor);
  const start = new Date(anchorDate.getTime() - minutes * 60 * 1000).toISOString();
  const end = new Date(anchorDate.getTime() + minutes * 60 * 1000).toISOString();
  return {
    start,
    end,
    field,
    conversationId,
  };
}

function matchesTemporalWindow(
  metadata: Record<string, unknown> | null,
  window: TemporalWindow
) {
  const safeMetadata = metadata ?? {};
  if (window.conversationId) {
    const conversationId =
      typeof safeMetadata.conversation_id === "string"
        ? safeMetadata.conversation_id
        : null;
    if (conversationId !== window.conversationId) {
      return false;
    }
  }
  const candidateTime = normalizeIso(safeMetadata[window.field]);
  if (!candidateTime) {
    return false;
  }
  return candidateTime >= window.start && candidateTime <= window.end;
}

export async function expandTemporalResonance(
  anchors: MemorySnippet[],
  options: {
    collectionName?: string;
    windowMinutes?: number;
  } = {}
) {
  if (anchors.length === 0) {
    return [];
  }
  const windowMinutes = options.windowMinutes ?? TEMPORAL_WINDOW_MINUTES;
  const anchorSlice = anchors.slice(0, TEMPORAL_ANCHOR_LIMIT);
  const results: MemorySnippet[] = [];

  for (const anchor of anchorSlice) {
    const anchorIso = resolveAnchorTime(anchor);
    if (!anchorIso) {
      continue;
    }
    const field = anchor.sourceAt ? "source_at" : "created_at";
    const window = buildTemporalWindow(
      anchorIso,
      windowMinutes,
      field,
      anchor.conversationId
    );
    if (!window) {
      continue;
    }
    const serverWhere = window.conversationId
      ? { conversation_id: window.conversationId }
      : undefined;
    let offset = 0;
    let scanned = 0;
    let collected = 0;

    while (scanned < TEMPORAL_MAX_SCAN && collected < TEMPORAL_RESULT_LIMIT) {
      const list = await listVectors(
        TEMPORAL_FETCH_BATCH,
        offset,
        options.collectionName,
        serverWhere
      );
      if (list.ids.length === 0) {
        break;
      }

      list.documents.forEach((doc, index) => {
        if (collected >= TEMPORAL_RESULT_LIMIT) {
          return;
        }
        if (typeof doc !== "string" || doc.trim().length === 0) {
          return;
        }
        const metadata = list.metadatas[index] ?? {};
        if (!matchesTemporalWindow(metadata ?? {}, window)) {
          return;
        }
        const memoryId = list.ids?.[index];
        results.push(buildMemorySnippet(doc, metadata ?? {}, memoryId));
        collected += 1;
      });

      scanned += list.ids.length;
      if (list.ids.length < TEMPORAL_FETCH_BATCH) {
        break;
      }
      offset += list.ids.length;
    }
  }

  const deduped = new Map<string, MemorySnippet>();
  for (const memory of results) {
    const memoryId = memory.id?.trim();
    const key = memoryId
      ? `id:${memoryId}`
      : `content:${memory.content.toLowerCase().trim()}`;
    if (!deduped.has(key)) {
      deduped.set(key, memory);
    }
  }

  for (const anchor of anchorSlice) {
    const anchorId = anchor.id?.trim();
    const anchorKey = anchorId
      ? `id:${anchorId}`
      : `content:${anchor.content.toLowerCase().trim()}`;
    deduped.delete(anchorKey);
  }

  return Array.from(deduped.values()).sort((a, b) => {
    const aTime = resolveAnchorTime(a);
    const bTime = resolveAnchorTime(b);
    if (aTime && bTime) {
      return bTime.localeCompare(aTime);
    }
    if (aTime) {
      return -1;
    }
    if (bTime) {
      return 1;
    }
    return 0;
  });
}
