import {
  PERSONAL_MEMORY_COLLECTION,
  normalizePersonalMemoryCategory,
} from "@/lib/personalMemory";
import { countVectors, listVectors } from "@/lib/vector";

type MemoryResponseItem = {
  id: string;
  content: string;
  createdAt?: string;
  sourceAt?: string;
  conversationId?: string;
  source?: string;
  model?: string;
  type?: string;
  category?: string;
  eventTime?: string;
  eventTimezone?: string;
  expiresAt?: string;
  tagsFlat?: string;
  resonanceTagsFlat?: string;
  resonancePrimary?: string;
  resonanceWeight?: string;
  resonanceIntensity?: number;
  resonanceState?: string;
};

function toNumber(value: string | null, fallback: number) {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limit = Math.min(200, Math.max(1, toNumber(url.searchParams.get("limit"), 15)));
    const offset = Math.max(0, toNumber(url.searchParams.get("offset"), 0));
    const typeFilter = url.searchParams.get("type");
    const categoryFilter = url.searchParams.get("category");
    const scope = url.searchParams.get("scope");
    const usePersonal = scope === "personal";
    const collectionName = usePersonal ? PERSONAL_MEMORY_COLLECTION : undefined;

    const total = await countVectors(collectionName);
    if (total === 0) {
      return Response.json({ total: 0, items: [] });
    }

    const normalizeType =
      !usePersonal && typeFilter && ["event", "profile", "fact"].includes(typeFilter)
        ? typeFilter
        : null;
    const normalizeCategory = usePersonal
      ? normalizePersonalMemoryCategory(categoryFilter)
      : null;

    const items: MemoryResponseItem[] = [];
    const hydrateItems = (batch: Awaited<ReturnType<typeof listVectors>>, base: number) => {
      batch.documents.forEach((doc, index) => {
        if (typeof doc !== "string" || doc.trim().length === 0) {
          return;
        }
        const metadata = batch.metadatas[index] ?? {};
        const createdAt =
          typeof metadata.created_at === "string" ? metadata.created_at : undefined;
        const sourceAt =
          typeof metadata.source_at === "string" ? metadata.source_at : undefined;
        const conversationId =
          typeof metadata.conversation_id === "string"
            ? metadata.conversation_id
            : undefined;
        const source =
          typeof metadata.source === "string" ? metadata.source : undefined;
        const model =
          typeof metadata.model === "string" ? metadata.model : undefined;
        const rawType = typeof metadata.type === "string" ? metadata.type : undefined;
        const type = rawType ?? (usePersonal ? "personal" : "fact");
        
        // Apply filters during hydration
        if (normalizeType && type !== normalizeType) {
          return;
        }
        const category =
          typeof metadata.category === "string" ? metadata.category : undefined;
        if (normalizeCategory && category !== normalizeCategory) {
          return;
        }

        const eventTime =
          typeof metadata.event_time === "string" ? metadata.event_time : undefined;
        const eventTimezone =
          typeof metadata.event_timezone === "string"
            ? metadata.event_timezone
            : undefined;
        const expiresAt =
          typeof metadata.expires_at === "string" ? metadata.expires_at : undefined;
        const tagsFlat =
          typeof metadata.tags_flat === "string" ? metadata.tags_flat : undefined;
        const resonanceTagsFlat =
          typeof metadata.resonance_tags_flat === "string"
            ? metadata.resonance_tags_flat
            : undefined;
        const resonancePrimary =
          typeof metadata.resonance_primary === "string"
            ? metadata.resonance_primary
            : undefined;
        const resonanceWeight =
          typeof metadata.resonance_weight === "string"
            ? metadata.resonance_weight
            : undefined;
        const resonanceIntensity =
          typeof metadata.resonance_intensity === "number"
            ? metadata.resonance_intensity
            : typeof metadata.resonance_intensity === "string"
              ? Number(metadata.resonance_intensity)
              : undefined;
        const resonanceState =
          typeof metadata.resonance_state === "string"
            ? metadata.resonance_state
            : undefined;

        items.push({
          id: batch.ids[index] ?? `${base + index}`,
          content: doc,
          createdAt,
          sourceAt,
          conversationId,
          source,
          model,
          type,
          category,
          eventTime,
          eventTimezone,
          expiresAt,
          tagsFlat,
          resonanceTagsFlat,
          resonancePrimary,
          resonanceWeight,
          resonanceIntensity:
            typeof resonanceIntensity === "number" && Number.isFinite(resonanceIntensity)
              ? resonanceIntensity
              : undefined,
          resonanceState,
        });
      });
    };

    // Fetch everything to ensure correct sorting and pagination
    // ChromaDB doesn't support server-side sorting by metadata
    const fetchBatchSize = 500;
    const pages = Math.ceil(total / fetchBatchSize);

    for (let page = 0; page < pages; page += 1) {
      const batchOffset = page * fetchBatchSize;
      const batch = await listVectors(fetchBatchSize, batchOffset, collectionName);
      hydrateItems(batch, batchOffset);
    }

    // Sort all items newest first
    items.sort((a, b) => {
      if (a.createdAt && b.createdAt) {
        return b.createdAt.localeCompare(a.createdAt);
      }
      if (a.createdAt) {
        return -1;
      }
      if (b.createdAt) {
        return 1;
      }
      return b.id.localeCompare(a.id); // Also sort by ID desc if no date
    });

    const paged = items.slice(offset, offset + limit);
    return Response.json({ total: items.length, items: paged });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to load memories.";
    return new Response(message, { status: 500 });
  }
}
