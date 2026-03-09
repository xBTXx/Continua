type VectorMetadata = Record<string, string | number | boolean | null>;

export type VectorRecord = {
  id: string;
  embedding: number[];
  document?: string;
  metadata?: VectorMetadata;
};

export type VectorQueryResult = {
  ids: string[];
  documents: Array<string | null>;
  metadatas: Array<VectorMetadata | null>;
  distances: number[];
};

export type VectorListResult = {
  ids: string[];
  documents: Array<string | null>;
  metadatas: Array<VectorMetadata | null>;
};

const CHROMA_URL = process.env.CHROMA_URL ?? "http://vector:8000";
const DEFAULT_COLLECTION = process.env.CHROMA_COLLECTION ?? "assistant_memories";
const CHROMA_TENANT = process.env.CHROMA_TENANT ?? "default";
const CHROMA_DATABASE = process.env.CHROMA_DATABASE ?? "default";
const RESET_ON_DIM_MISMATCH =
  process.env.CHROMA_RESET_ON_DIM_MISMATCH === "true" ||
  process.env.NODE_ENV === "development";

type CollectionInfo = {
  id: string;
  name: string;
  dimension?: number | null;
};

async function chromaRequest(
  path: string,
  body?: Record<string, unknown>,
  options: {
    allowConflict?: boolean;
    allowNotFound?: boolean;
    method?: "GET" | "POST" | "DELETE";
  } = {}
) {
  const method = options.method ?? (body ? "POST" : "GET");
  const response = await fetch(`${CHROMA_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    if (options.allowConflict && response.status === 409) {
      return null;
    }
    if (options.allowNotFound && response.status === 404) {
      return null;
    }
    const errorText = await response.text();
    const message = errorText || `HTTP ${response.status}`;
    throw new Error(`ChromaDB request failed: ${message}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

function isInvalidWhereClauseError(error: unknown) {
  return (
    error instanceof Error &&
    error.message.toLowerCase().includes("invalid where clause")
  );
}

function isInvalidWhereDocumentClauseError(error: unknown) {
  return (
    error instanceof Error &&
    error.message.toLowerCase().includes("invalid where document clause")
  );
}

async function withWhereFallback<T>(
  context: string,
  where: Record<string, unknown> | undefined,
  request: (whereClause?: Record<string, unknown>) => Promise<T>
) {
  try {
    return await request(where);
  } catch (error) {
    if (!where || !isInvalidWhereClauseError(error)) {
      throw error;
    }
    console.warn(
      `Chroma rejected where filter in ${context}; retrying request without where.`
    );
    return request(undefined);
  }
}

async function ensureDatabase() {
  await chromaRequest(
    `/api/v2/tenants/${CHROMA_TENANT}/databases`,
    { name: CHROMA_DATABASE },
    { allowConflict: true }
  );
}

async function createCollection(name: string): Promise<CollectionInfo | null> {
  await ensureDatabase();
  return (await chromaRequest(
    `/api/v2/tenants/${CHROMA_TENANT}/databases/${CHROMA_DATABASE}/collections`,
    { name },
    { allowConflict: true }
  )) as CollectionInfo | null;
}

async function getOrCreateCollectionInfo(name: string): Promise<CollectionInfo> {
  await ensureDatabase();
  const data = (await chromaRequest(
    `/api/v2/tenants/${CHROMA_TENANT}/databases/${CHROMA_DATABASE}/collections`
  )) as CollectionInfo[];

  const found = data.find((collection) => collection.name === name);
  if (found) {
    return found;
  }

  const created = await createCollection(name);
  if (created) {
    return created;
  }

  const refreshed = (await chromaRequest(
    `/api/v2/tenants/${CHROMA_TENANT}/databases/${CHROMA_DATABASE}/collections`
  )) as CollectionInfo[];
  const refreshedFound = refreshed.find((collection) => collection.name === name);
  if (refreshedFound) {
    return refreshedFound;
  }

  throw new Error(`ChromaDB request failed: Collection ${name} missing.`);
}

async function deleteCollection(collectionId: string) {
  await chromaRequest(
    `/api/v2/tenants/${CHROMA_TENANT}/databases/${CHROMA_DATABASE}/collections/${collectionId}`,
    undefined,
    { method: "DELETE", allowNotFound: true }
  );
}

async function resolveCollectionForEmbedding(
  name: string,
  embeddingLength: number
) {
  let collection = await getOrCreateCollectionInfo(name);
  const knownDimension = collection.dimension ?? null;

  if (knownDimension && knownDimension !== embeddingLength) {
    if (!RESET_ON_DIM_MISMATCH) {
      throw new Error(
        `Chroma collection dimension mismatch: expected ${knownDimension}, got ${embeddingLength}.`
      );
    }

    await deleteCollection(collection.id);
    const created = await createCollection(name);
    collection = created ?? (await getOrCreateCollectionInfo(name));
  }

  return collection;
}

export async function upsertVectors(
  records: VectorRecord[],
  collectionName?: string
) {
  if (records.length === 0) {
    return;
  }

  const embeddingLength = records[0]?.embedding?.length ?? 0;
  if (embeddingLength === 0) {
    return;
  }

  const targetCollection = collectionName ?? DEFAULT_COLLECTION;
  const collection = await resolveCollectionForEmbedding(
    targetCollection,
    embeddingLength
  );
  await chromaRequest(
    `/api/v2/tenants/${CHROMA_TENANT}/databases/${CHROMA_DATABASE}/collections/${collection.id}/upsert`,
    {
      ids: records.map((record) => record.id),
      embeddings: records.map((record) => record.embedding),
      documents: records.map((record) => record.document ?? ""),
      metadatas: records.map((record) => record.metadata ?? {}),
    }
  );
}

export async function queryVectors(
  embedding: number[],
  topK = 5,
  collectionName?: string,
  where?: Record<string, unknown>
): Promise<VectorQueryResult> {
  const embeddingLength = embedding.length;
  if (embeddingLength === 0) {
    return { ids: [], documents: [], metadatas: [], distances: [] };
  }

  const targetCollection = collectionName ?? DEFAULT_COLLECTION;
  const collection = await resolveCollectionForEmbedding(
    targetCollection,
    embeddingLength
  );
  const data = (await withWhereFallback(
    "queryVectors",
    where,
    (whereClause) =>
      chromaRequest(
        `/api/v2/tenants/${CHROMA_TENANT}/databases/${CHROMA_DATABASE}/collections/${collection.id}/query`,
        {
          query_embeddings: [embedding],
          n_results: topK,
          where: whereClause,
          include: ["documents", "metadatas", "distances"],
        }
      )
  )) as {
    ids?: string[][];
    documents?: Array<Array<string | null>>;
    metadatas?: Array<Array<VectorMetadata | null>>;
    distances?: number[][];
  };

  return {
    ids: data.ids?.[0] ?? [],
    documents: data.documents?.[0] ?? [],
    metadatas: data.metadatas?.[0] ?? [],
    distances: data.distances?.[0] ?? [],
  };
}

/**
 * Keyword-based search using ChromaDB's where_document filtering.
 * Extracts keywords from query and searches for documents containing them.
 */
export async function keywordSearchVectors(
  query: string,
  topK = 5,
  collectionName?: string,
  where?: Record<string, unknown>
): Promise<VectorListResult> {
  const trimmed = query.trim();
  if (!trimmed) {
    return { ids: [], documents: [], metadatas: [] };
  }

  // Extract meaningful keywords (3+ chars, no stopwords)
  const STOPWORDS = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "must", "can", "to", "of", "in", "for",
    "on", "with", "at", "by", "from", "as", "into", "through", "during",
    "before", "after", "above", "below", "between", "under", "again",
    "further", "then", "once", "here", "there", "when", "where", "why",
    "how", "all", "each", "few", "more", "most", "other", "some", "such",
    "no", "nor", "not", "only", "own", "same", "so", "than", "too", "very",
    "just", "and", "but", "or", "if", "because", "until", "while", "about",
    "against", "out", "up", "down", "off", "over", "any", "both", "this",
    "that", "these", "those", "what", "which", "who", "whom", "i", "you",
    "he", "she", "it", "we", "they", "me", "him", "her", "us", "them",
    "my", "your", "his", "its", "our", "their", "myself", "yourself",
  ]);

  const words = trimmed
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word));

  if (words.length === 0) {
    return { ids: [], documents: [], metadatas: [] };
  }

  // Use the most significant keywords (up to 3)
  const keywords = words.slice(0, 3);

  const targetCollection = collectionName ?? DEFAULT_COLLECTION;
  const collection = await getOrCreateCollectionInfo(targetCollection);

  // Search for each keyword and merge results
  const resultSets: Map<string, { doc: string | null; meta: VectorMetadata | null; matchCount: number }> = new Map();
  let whereDocumentUnsupported = false;

  for (const keyword of keywords) {
    if (whereDocumentUnsupported) {
      break;
    }
    try {
      const whereDocument = { "$contains": keyword };
      const data = (await withWhereFallback(
        "keywordSearchVectors",
        where,
        (whereClause) =>
          chromaRequest(
            `/api/v2/tenants/${CHROMA_TENANT}/databases/${CHROMA_DATABASE}/collections/${collection.id}/get`,
            {
              limit: topK * 2,
              where: whereClause,
              where_document: whereDocument,
              include: ["documents", "metadatas"],
            }
          )
      )) as {
        ids?: string[];
        documents?: Array<string | null>;
        metadatas?: Array<VectorMetadata | null>;
      };

      const ids = data.ids ?? [];
      const docs = data.documents ?? [];
      const metas = data.metadatas ?? [];

      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const existing = resultSets.get(id);
        if (existing) {
          existing.matchCount += 1;
        } else {
          resultSets.set(id, {
            doc: docs[i] ?? null,
            meta: metas[i] ?? null,
            matchCount: 1,
          });
        }
      }
    } catch (error) {
      if (isInvalidWhereDocumentClauseError(error)) {
        console.warn(
          "Chroma where_document filtering is unsupported in this version; keyword search is disabled."
        );
        whereDocumentUnsupported = true;
        continue;
      }
      // Continue with other keywords if one fails
      console.warn(`Keyword search failed for "${keyword}":`, error);
    }
  }

  // Sort by match count (more keyword matches = higher rank)
  const sorted = Array.from(resultSets.entries())
    .sort((a, b) => b[1].matchCount - a[1].matchCount)
    .slice(0, topK);

  return {
    ids: sorted.map(([id]) => id),
    documents: sorted.map(([, val]) => val.doc),
    metadatas: sorted.map(([, val]) => val.meta),
  };
}

export async function listVectors(
  limit = 100,
  offset = 0,
  collectionName?: string,
  where?: Record<string, unknown>
): Promise<VectorListResult> {
  const targetCollection = collectionName ?? DEFAULT_COLLECTION;
  const collection = await getOrCreateCollectionInfo(targetCollection);
  const data = (await withWhereFallback(
    "listVectors",
    where,
    (whereClause) =>
      chromaRequest(
        `/api/v2/tenants/${CHROMA_TENANT}/databases/${CHROMA_DATABASE}/collections/${collection.id}/get`,
        {
          limit,
          offset,
          where: whereClause,
          include: ["documents", "metadatas"],
        }
      )
  )) as {
    ids?: string[];
    documents?: Array<string | null>;
    metadatas?: Array<VectorMetadata | null>;
  };

  return {
    ids: data.ids ?? [],
    documents: data.documents ?? [],
    metadatas: data.metadatas ?? [],
  };
}

export async function deleteVectors(
  ids: string[],
  collectionName?: string
) {
  if (ids.length === 0) {
    return;
  }

  const targetCollection = collectionName ?? DEFAULT_COLLECTION;
  const collection = await getOrCreateCollectionInfo(targetCollection);
  await chromaRequest(
    `/api/v2/tenants/${CHROMA_TENANT}/databases/${CHROMA_DATABASE}/collections/${collection.id}/delete`,
    { ids }
  );
}

export async function updateVectors(
  updates: Array<{ id: string; metadata?: VectorMetadata; document?: string }>,
  collectionName?: string
) {
  if (updates.length === 0) {
    return;
  }

  const targetCollection = collectionName ?? DEFAULT_COLLECTION;
  const collection = await getOrCreateCollectionInfo(targetCollection);
  const ids = updates.map((update) => update.id);
  const metadatas = updates.map((update) => update.metadata ?? {});

  const includeDocuments = updates.every(
    (update) => typeof update.document === "string"
  );
  const body: Record<string, unknown> = { ids, metadatas };
  if (includeDocuments) {
    body.documents = updates.map((update) => update.document ?? "");
  }

  await chromaRequest(
    `/api/v2/tenants/${CHROMA_TENANT}/databases/${CHROMA_DATABASE}/collections/${collection.id}/update`,
    body
  );
}

export async function countVectors(
  collectionName?: string
): Promise<number> {
  const targetCollection = collectionName ?? DEFAULT_COLLECTION;
  const collection = await getOrCreateCollectionInfo(targetCollection);
  const data = await chromaRequest(
    `/api/v2/tenants/${CHROMA_TENANT}/databases/${CHROMA_DATABASE}/collections/${collection.id}/count`
  );

  if (typeof data === "number") {
    return data;
  }

  if (typeof data === "string") {
    const parsed = Number(data);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  if (data && typeof data === "object" && "count" in data) {
    const count = (data as { count?: number }).count;
    return typeof count === "number" ? count : 0;
  }

  return 0;
}
