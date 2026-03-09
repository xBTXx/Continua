import { PERSONAL_MEMORY_COLLECTION } from "./personalMemory";
import { listVectors, updateVectors } from "./vector";
import { getIdleConfig } from "./idleState";
import { generateIdleResonanceMetadata } from "./idle/generation";
import { IdleSeed, IdleThought, IdleSeedSource } from "./idle/types";

export type IdleResonanceBackfillOptions = {
  maxRecords?: number;
  batchSize?: number;
  dryRun?: boolean;
  force?: boolean;
};

export type IdleResonanceBackfillResult = {
  status: "ok";
  scanned: number;
  updated: number;
  dryRun: boolean;
  force: boolean;
  scope: "personal";
  source: "idle_state";
};

const DEFAULT_BATCH_SIZE = 12;
const DEFAULT_TEMPORAL_WINDOW = 20;
const IDLE_SEED_SOURCES: IdleSeedSource[] = [
  "main_memory",
  "personal_memory",
  "personal_context",
  "scratchpad",
  "calendar_event",
];
const IDLE_SEED_SOURCE_SET = new Set<string>(IDLE_SEED_SOURCES);

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function isPrimitive(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function normalizeMetadata(
  raw: Record<string, unknown> | null
): Record<string, string | number | boolean | null> {
  const metadata: Record<string, string | number | boolean | null> = {};
  if (!raw) {
    return metadata;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (isPrimitive(value)) {
      metadata[key] = value;
    }
  }
  return metadata;
}

function normalizeIsoDate(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
}

function parseTagList(raw?: string | null) {
  if (!raw || typeof raw !== "string") {
    return [];
  }
  return raw
    .split("|")
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => tag.length > 0);
}

function serializeTagList(tags: string[]) {
  if (!Array.isArray(tags) || tags.length === 0) {
    return null;
  }
  return tags.join("|");
}

function normalizeSeedSource(value: unknown): IdleSeedSource {
  if (typeof value !== "string") {
    return "personal_memory";
  }
  const normalized = value.trim().toLowerCase();
  return IDLE_SEED_SOURCE_SET.has(normalized)
    ? (normalized as IdleSeedSource)
    : "personal_memory";
}

function shouldBackfillResonance(
  metadata: Record<string, string | number | boolean | null>,
  force: boolean
) {
  if (force) {
    return true;
  }
  return (
    typeof metadata.resonance_tags_flat !== "string" ||
    typeof metadata.resonance_weight !== "string" ||
    typeof metadata.resonance_state !== "string" ||
    typeof metadata.resonance_intensity !== "number" ||
    typeof metadata.resonance_primary !== "string"
  );
}

function applyResonanceMetadata(
  metadata: Record<string, string | number | boolean | null>,
  resonance: {
    resonanceTags: string[];
    resonanceWeight: string | null;
    resonanceIntensity: number | null;
    resonanceState: string | null;
    resonanceMotifs: string[];
  },
  force: boolean
) {
  const next = { ...metadata };
  let changed = false;

  if (!normalizeIsoDate(next.source_at)) {
    const fallback = normalizeIsoDate(next.created_at) ?? new Date().toISOString();
    next.source_at = fallback;
    changed = true;
  }

  if (typeof next.temporal_window_min !== "number") {
    next.temporal_window_min = DEFAULT_TEMPORAL_WINDOW;
    changed = true;
  }

  const existingTags = parseTagList(
    typeof next.resonance_tags_flat === "string" ? next.resonance_tags_flat : ""
  );
  const existingMotifs = parseTagList(
    typeof next.resonance_motifs_flat === "string"
      ? next.resonance_motifs_flat
      : ""
  );

  const tagsForUpdate =
    existingTags.length > 0 && !force ? existingTags : resonance.resonanceTags;
  const motifsForUpdate =
    existingMotifs.length > 0 && !force ? existingMotifs : resonance.resonanceMotifs;

  if (force || typeof next.resonance_tags_flat !== "string") {
    const serialized = serializeTagList(tagsForUpdate);
    if (serialized !== next.resonance_tags_flat) {
      next.resonance_tags_flat = serialized;
      changed = true;
    }
  }

  if (force || typeof next.resonance_motifs_flat !== "string") {
    const serialized = serializeTagList(motifsForUpdate);
    if (serialized !== next.resonance_motifs_flat) {
      next.resonance_motifs_flat = serialized;
      changed = true;
    }
  }

  if (force || typeof next.resonance_weight !== "string") {
    const weight = resonance.resonanceWeight ?? "transient";
    if (weight !== next.resonance_weight) {
      next.resonance_weight = weight;
      changed = true;
    }
  }

  if (force || typeof next.resonance_intensity !== "number") {
    const intensity = resonance.resonanceIntensity ?? 2;
    if (intensity !== next.resonance_intensity) {
      next.resonance_intensity = intensity;
      changed = true;
    }
  }

  if (force || typeof next.resonance_state !== "string") {
    const state = resonance.resonanceState ?? "quiet";
    if (state !== next.resonance_state) {
      next.resonance_state = state;
      changed = true;
    }
  }

  if (force || typeof next.resonance_primary !== "string") {
    const tags = parseTagList(
      typeof next.resonance_tags_flat === "string"
        ? next.resonance_tags_flat
        : serializeTagList(tagsForUpdate)
    );
    const primary = tags[0] ?? null;
    if (primary !== next.resonance_primary) {
      next.resonance_primary = primary;
      changed = true;
    }
  }

  return { next, changed };
}

export async function runIdleResonanceBackfill(
  options: IdleResonanceBackfillOptions = {}
): Promise<IdleResonanceBackfillResult> {
  const dryRun = Boolean(options.dryRun);
  const force = Boolean(options.force);
  const batchSize = clamp(options.batchSize ?? DEFAULT_BATCH_SIZE, 1, 50);
  const maxRecords = Number.isFinite(options.maxRecords ?? Number.NaN)
    ? Math.max(1, Math.floor(options.maxRecords as number))
    : Number.POSITIVE_INFINITY;

  const idleConfig = await getIdleConfig();
  const where = { source: "idle_state" };

  let scanned = 0;
  let updated = 0;
  let offset = 0;

  while (scanned < maxRecords) {
    const remaining = Number.isFinite(maxRecords)
      ? maxRecords - scanned
      : batchSize;
    const limit = Math.min(batchSize, remaining);
    const batch = await listVectors(limit, offset, PERSONAL_MEMORY_COLLECTION, where);
    if (batch.ids.length === 0) {
      break;
    }

    const updates: Array<{
      id: string;
      metadata: Record<string, string | number | boolean | null>;
    }> = [];

    for (let i = 0; i < batch.ids.length; i += 1) {
      const id = batch.ids[i];
      const document = batch.documents[i];
      const metadata = normalizeMetadata(batch.metadatas[i] ?? null);
      scanned += 1;

      if (typeof document !== "string" || !document.trim()) {
        continue;
      }
      if (!shouldBackfillResonance(metadata, force)) {
        continue;
      }

      const thought: IdleThought = {
        seedId:
          typeof metadata.idle_seed_id === "string"
            ? metadata.idle_seed_id
            : `idle_seed:${id}`,
        thought: document.trim(),
        tas: {
          temporal:
            typeof metadata.idle_tas_temporal === "string"
              ? metadata.idle_tas_temporal
              : undefined,
          valence:
            typeof metadata.idle_tas_valence === "string"
              ? metadata.idle_tas_valence
              : undefined,
          self_relevance:
            typeof metadata.idle_tas_self === "string"
              ? metadata.idle_tas_self
              : undefined,
        },
      };

      const seed: IdleSeed = {
        id: thought.seedId,
        source: normalizeSeedSource(metadata.idle_seed_source),
        content: thought.thought,
        createdAt: normalizeIsoDate(metadata.created_at),
        metadata,
      };

      const resonance =
        (await generateIdleResonanceMetadata(thought, seed, idleConfig)) ?? {
          resonanceTags: ["reflection"],
          resonanceWeight: "transient",
          resonanceIntensity: 2,
          resonanceState: "quiet",
          resonanceMotifs: [],
        };

      const { next, changed } = applyResonanceMetadata(metadata, resonance, force);
      if (changed) {
        updates.push({ id, metadata: next });
      }

      if (scanned >= maxRecords) {
        break;
      }
    }

    if (updates.length > 0) {
      updated += updates.length;
      if (!dryRun) {
        await updateVectors(updates, PERSONAL_MEMORY_COLLECTION);
      }
    }

    if (batch.ids.length < limit) {
      break;
    }
    offset += batch.ids.length;
  }

  return {
    status: "ok",
    scanned,
    updated,
    dryRun,
    force,
    scope: "personal",
    source: "idle_state",
  };
}
