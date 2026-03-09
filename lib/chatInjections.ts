import { randomUUID } from "node:crypto";
import { ensureSchema, query } from "./db";
import type { ChatMessage, ToolDefinition } from "./openrouter";

export type InjectionMemory = {
  content: string;
  createdAt?: string;
  sourceAt?: string;
};

export type InjectionExcerptMessage = {
  id: string;
  role: string;
  content: string;
  createdAt?: string;
};

export type InjectionConversationExcerpt = {
  conversationId: string;
  memoryContent: string;
  messages: InjectionExcerptMessage[];
};

export type InjectionContextBlock = {
  label: string;
  content: string;
};

export type ChatInjectionPayload = {
  queries?: string[];
  personalQueries?: string[];
  resonanceQueries?: string[];
  resonanceTags?: string[];
  resonanceWeight?: string;
  injectedMemories?: InjectionMemory[];
  injectedPersonalMemories?: InjectionMemory[];
  memories?: InjectionMemory[];
  resonantMemories?: InjectionMemory[];
  temporalMemories?: InjectionMemory[];
  personalMemories?: InjectionMemory[];
  resonantPersonalMemories?: InjectionMemory[];
  temporalPersonalMemories?: InjectionMemory[];
  conversationExcerpts?: InjectionConversationExcerpt[];
  scratchpadNotes?: InjectionMemory[];
  calendarReminders?: InjectionMemory[];
  toolHistory?: string | null;
  workspaceHistory?: string | null;
  injectedBlocks?: InjectionContextBlock[];
  toolCategoriesPredicted?: string[];
  toolCategoriesHeuristic?: string[];
  toolCategoriesFollowup?: string[];
  toolCategoriesRecent?: string[];
  toolCategoriesSelected?: string[];
  ssefSelectionQuery?: string;
  toolConfidence?: string;
  contextMessages?: ChatMessage[];
  toolDefinitions?: ToolDefinition[];
};

export type ChatInjectionLog = {
  id: string;
  conversationId: string | null;
  messageId: string | null;
  payload: ChatInjectionPayload;
  createdAt: string;
};

export async function createChatInjectionLog({
  conversationId,
  payload,
}: {
  conversationId?: string | null;
  payload: ChatInjectionPayload;
}) {
  await ensureSchema();
  const id = randomUUID();
  await query(
    `
      INSERT INTO chat_injection_log (id, conversation_id, payload)
      VALUES ($1, $2, $3)
    `,
    [id, conversationId ?? null, JSON.stringify(payload)]
  );
  return id;
}

export async function attachChatInjectionToMessage({
  injectionId,
  messageId,
  conversationId,
}: {
  injectionId: string;
  messageId: string;
  conversationId?: string | null;
}) {
  await ensureSchema();
  await query(
    `
      UPDATE chat_injection_log
      SET message_id = $1,
          conversation_id = COALESCE(conversation_id, $2)
      WHERE id = $3
    `,
    [messageId, conversationId ?? null, injectionId]
  );
}

export async function getChatInjectionById(id: string) {
  const trimmed = id.trim();
  if (!trimmed) {
    return null;
  }
  await ensureSchema();
  const result = await query<{
    id: string;
    conversation_id: string | null;
    message_id: string | null;
    payload: ChatInjectionPayload;
    created_at: string;
  }>(
    `
      SELECT id, conversation_id, message_id, payload, created_at
      FROM chat_injection_log
      WHERE id = $1
      LIMIT 1
    `,
    [trimmed]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    payload: row.payload ?? {},
    createdAt: row.created_at,
  } satisfies ChatInjectionLog;
}
