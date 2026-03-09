import { randomUUID } from "node:crypto";
import { ensureSchema, query } from "./db";

export type PersonalMemoryContextMessage = {
  role: "user" | "assistant";
  content: string;
};

export type PersonalMemoryContextRecord = {
  id: string;
  personalMemoryId: string;
  createdAt: string;
  messages: PersonalMemoryContextMessage[];
};

type SavePersonalMemoryContextInput = {
  personalMemoryId: string;
  conversationId?: string | null;
  messages: PersonalMemoryContextMessage[];
};

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function savePersonalMemoryContext({
  personalMemoryId,
  conversationId,
  messages,
}: SavePersonalMemoryContextInput) {
  const trimmedId = personalMemoryId.trim();
  if (!trimmedId || messages.length === 0) {
    return { status: "skipped" };
  }

  const safeConversationId =
    conversationId && UUID_REGEX.test(conversationId) ? conversationId : null;

  await ensureSchema();
  const contextId = randomUUID();
  await query(
    `
      INSERT INTO personal_memory_contexts (id, personal_memory_id, conversation_id, messages)
      VALUES ($1, $2, $3, $4)
    `,
    [contextId, trimmedId, safeConversationId, JSON.stringify(messages)]
  );

  return { status: "ok", id: contextId };
}

type PersonalMemoryContextRow = {
  id: string;
  personal_memory_id: string;
  messages: unknown;
  created_at: string;
};

function isPersonalMemoryContextMessage(
  entry: unknown
): entry is PersonalMemoryContextMessage {
  return Boolean(
    entry &&
      typeof entry === "object" &&
      ((entry as { role?: unknown }).role === "user" ||
        (entry as { role?: unknown }).role === "assistant") &&
      typeof (entry as { content?: unknown }).content === "string" &&
      (entry as { content: string }).content.trim().length > 0
  );
}

export async function listPersonalMemoryContexts(limit = 10) {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 10;
  await ensureSchema();
  const result = await query<PersonalMemoryContextRow>(
    `
      SELECT id, personal_memory_id, messages, created_at
      FROM personal_memory_contexts
      ORDER BY created_at DESC
      LIMIT $1
    `,
    [safeLimit]
  );

  const records: PersonalMemoryContextRecord[] = [];
  for (const row of result.rows) {
    if (!row) {
      continue;
    }
    try {
      const rawMessages = row.messages;
      const parsed =
        typeof rawMessages === "string" ? JSON.parse(rawMessages) : rawMessages;
      if (!Array.isArray(parsed)) {
        continue;
      }
      const messages = parsed.filter(isPersonalMemoryContextMessage);
      if (messages.length === 0) {
        continue;
      }
      records.push({
        id: row.id,
        personalMemoryId: row.personal_memory_id,
        createdAt: row.created_at,
        messages,
      });
    } catch {
      continue;
    }
  }
  return records;
}
