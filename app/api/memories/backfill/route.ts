import { PERSONAL_MEMORY_COLLECTION } from "@/lib/personalMemory";
import { countVectors, listVectors, updateVectors } from "@/lib/vector";
import {
  runIdleResonanceBackfill,
  IdleResonanceBackfillOptions,
} from "@/lib/idleResonanceBackfill";

type BackfillPayload = {
  scope?: "personal" | "main";
  maxRecords?: number;
  batchSize?: number;
  dryRun?: boolean;
  mode?: "metadata" | "idle_resonance";
  idleResonance?: boolean;
  force?: boolean;
};

const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_TEMPORAL_WINDOW = 20;

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

function buildBackfillMetadata(
  metadata: Record<string, string | number | boolean | null>
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

  if (typeof next.tags_flat !== "string") {
    const typeTag = typeof next.type === "string" ? next.type.trim() : "";
    if (typeTag) {
      next.tags_flat = typeTag.toLowerCase();
      changed = true;
    }
  }

  if (typeof next.resonance_weight !== "string") {
    next.resonance_weight = "transient";
    changed = true;
  }

  if (typeof next.resonance_primary !== "string") {
    const tags = parseTagList(
      typeof next.resonance_tags_flat === "string" ? next.resonance_tags_flat : ""
    );
    if (tags.length > 0) {
      next.resonance_primary = tags[0];
      changed = true;
    }
  }

  if (typeof next.resonance_tags_flat !== "string") {
    const primary =
      typeof next.resonance_primary === "string"
        ? next.resonance_primary.trim().toLowerCase()
        : "";
    if (primary) {
      next.resonance_tags_flat = primary;
      changed = true;
    }
  }

  return { next, changed };
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json().catch(() => ({}))) as BackfillPayload;
    const idleResonanceRequested =
      payload.mode === "idle_resonance" || payload.idleResonance === true;
    if (idleResonanceRequested) {
      const idleOptions: IdleResonanceBackfillOptions = {
        maxRecords: payload.maxRecords,
        batchSize: payload.batchSize,
        dryRun: payload.dryRun,
        force: payload.force,
      };
      const result = await runIdleResonanceBackfill(idleOptions);
      return Response.json(result);
    }
    const scope = payload.scope ?? "main";
    const collectionName =
      scope === "personal" ? PERSONAL_MEMORY_COLLECTION : undefined;
    const total = await countVectors(collectionName);
    if (total === 0) {
      return Response.json({
        status: "ok",
        total: 0,
        scanned: 0,
        updated: 0,
        dryRun: Boolean(payload.dryRun),
      });
    }

    const maxRecords = clamp(
      payload.maxRecords ?? total,
      1,
      total
    );
    const batchSize = clamp(
      payload.batchSize ?? DEFAULT_BATCH_SIZE,
      1,
      1000
    );
    const dryRun = Boolean(payload.dryRun);

    let scanned = 0;
    let updated = 0;
    let offset = 0;

    while (scanned < maxRecords && offset < total) {
      const remaining = maxRecords - scanned;
      const limit = Math.min(batchSize, remaining);
      const batch = await listVectors(limit, offset, collectionName);
      scanned += batch.ids.length;
      offset += batch.ids.length;

      const updates: Array<{
        id: string;
        metadata: Record<string, string | number | boolean | null>;
      }> = [];

      batch.ids.forEach((id, index) => {
        const metadata = normalizeMetadata(batch.metadatas[index] ?? null);
        const { next, changed } = buildBackfillMetadata(metadata);
        if (changed) {
          updates.push({ id, metadata: next });
        }
      });

      if (updates.length > 0) {
        updated += updates.length;
        if (!dryRun) {
          await updateVectors(updates, collectionName);
        }
      }

      if (batch.ids.length < limit) {
        break;
      }
    }

    return Response.json({
      status: "ok",
      total,
      scanned,
      updated,
      dryRun,
      scope,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to backfill memories.";
    return new Response(message, { status: 500 });
  }
}
