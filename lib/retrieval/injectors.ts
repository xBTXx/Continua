import { type ChatMessage } from "../openrouter";
import { ensureSchema, query } from "../db";
import {
  formatIdleActionLogEntries,
  listIdleActionLogEntries,
} from "../idleActions";
import { listIdleWorkspaceSummaries } from "../idleWorkspaceSummaries";
import {
  EXCERPT_MEMORY_LIMIT,
  EXCERPT_MESSAGE_LIMIT,
  EXCERPT_MESSAGE_MAX_CHARS,
} from "./config";
import {
  estimateTokens,
  formatMemoryDate,
  isUuid,
  truncateText,
} from "./helpers";
import type {
  ConversationExcerpt,
  ConversationExcerptMessage,
  MemorySnippet,
} from "./types";

export function buildMemoryBlock(label: string, memories: MemorySnippet[]) {
  return [
    label,
    ...memories.map((memory) => {
      const stamp = formatMemoryDate(memory.sourceAt ?? memory.createdAt);
      const prefix = stamp ? `[${stamp}] ` : "";
      return `- ${prefix}${memory.content}`;
    }),
  ].join("\n");
}

function injectMemoryBlock(
  messages: ChatMessage[],
  label: string,
  memories: MemorySnippet[]
): ChatMessage[] {
  if (memories.length === 0) {
    return messages;
  }

  const memoryBlock = buildMemoryBlock(label, memories);

  const systemIndex = messages.findIndex((message) => message.role === "system");
  if (systemIndex === -1) {
    return [{ role: "system", content: memoryBlock }, ...messages];
  }

  const updated = [...messages];
  const current = updated[systemIndex];
  updated[systemIndex] = {
    ...current,
    content: `${current.content}\n\n${memoryBlock}`,
  } as ChatMessage;
  return updated;
}

export function injectMemories(
  messages: ChatMessage[],
  memories: MemorySnippet[]
): ChatMessage[] {
  return injectMemoryBlock(messages, "Relevant memories:", memories);
}

export function injectPersonalMemories(
  messages: ChatMessage[],
  memories: MemorySnippet[]
): ChatMessage[] {
  return injectMemoryBlock(messages, "Assistant personal memories:", memories);
}

export function injectScratchpadNotes(
  messages: ChatMessage[],
  notes: MemorySnippet[]
): ChatMessage[] {
  return injectMemoryBlock(messages, "Scratchpad notes (temporary):", notes);
}

export function injectCalendarReminders(
  messages: ChatMessage[],
  reminders: MemorySnippet[]
): ChatMessage[] {
  return injectMemoryBlock(messages, "Calendar reminders (due):", reminders);
}

export function buildConversationExcerptBlock(
  excerpts: ConversationExcerpt[]
) {
  const sections = excerpts.map((excerpt, index) => {
    const header = `Excerpt ${index + 1} (memory: ${truncateText(
      excerpt.memoryContent,
      160
    )})`;
    const lines = excerpt.messages.map((message) => {
      const stamp = message.createdAt ? `[${formatMemoryDate(message.createdAt)}] ` : "";
      const role = message.role.toUpperCase();
      return `- ${stamp}${role}: ${truncateText(
        message.content,
        EXCERPT_MESSAGE_MAX_CHARS
      )}`;
    });
    return [header, ...lines].join("\n");
  });

  return `Conversation excerpts (from memory sources):\n${sections.join("\n\n")}`;
}

async function listConversationMessagesById(
  conversationId: string,
  messageIds: string[]
): Promise<ConversationExcerptMessage[]> {
  const uniqueIds = Array.from(new Set(messageIds)).filter(isUuid);
  if (uniqueIds.length === 0) {
    return [];
  }
  await ensureSchema();
  const result = await query<{
    id: string;
    role: string;
    content: string;
    created_at: string;
  }>(
    `
      SELECT id, role, content, created_at
      FROM messages
      WHERE conversation_id = $1
        AND id = ANY($2::uuid[])
      ORDER BY created_at ASC
    `,
    [conversationId, uniqueIds]
  );
  return result.rows.map((row) => ({
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  }));
}

export async function retrieveConversationExcerpts(
  memories: MemorySnippet[],
  options?: { maxMemories?: number; maxMessages?: number }
): Promise<ConversationExcerpt[]> {
  const maxMemories = options?.maxMemories ?? EXCERPT_MEMORY_LIMIT;
  const maxMessages = options?.maxMessages ?? EXCERPT_MESSAGE_LIMIT;
  const candidates = memories.filter(
    (memory) =>
      memory.conversationId &&
      memory.sourceMessageIds &&
      memory.sourceMessageIds.length > 0
  );
  if (candidates.length === 0 || maxMemories <= 0 || maxMessages <= 0) {
    return [];
  }

  const results: ConversationExcerpt[] = [];
  const seen = new Set<string>();

  for (const memory of candidates) {
    if (results.length >= maxMemories) {
      break;
    }
    const conversationId = memory.conversationId as string;
    const sourceIds = memory.sourceMessageIds as string[];
    const startId = memory.sourceMessageStartId ?? sourceIds[0];
    const endId =
      memory.sourceMessageEndId ?? sourceIds[sourceIds.length - 1];
    const key = `${conversationId}:${startId}:${endId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const limitedIds =
      sourceIds.length > maxMessages
        ? sourceIds.slice(sourceIds.length - maxMessages)
        : sourceIds;

    try {
      const messages = await listConversationMessagesById(
        conversationId,
        limitedIds
      );
      if (messages.length === 0) {
        continue;
      }
      results.push({
        conversationId,
        memoryContent: memory.content,
        messages,
      });
    } catch (error) {
      console.warn("Failed to load conversation excerpt.", error);
    }
  }

  return results;
}

export function injectConversationExcerpts(
  messages: ChatMessage[],
  excerpts: ConversationExcerpt[]
): ChatMessage[] {
  if (excerpts.length === 0) {
    return messages;
  }
  const block = buildConversationExcerptBlock(excerpts);
  const systemIndex = messages.findIndex((message) => message.role === "system");
  if (systemIndex === -1) {
    return [{ role: "system", content: block }, ...messages];
  }
  const updated = [...messages];
  const current = updated[systemIndex];
  updated[systemIndex] = {
    ...current,
    content: `${current.content}\n\n${block}`,
  } as ChatMessage;
  return updated;
}

export async function retrieveToolHistory(limit = 15) {
  try {
    const entries = await listIdleActionLogEntries(limit);
    return formatIdleActionLogEntries(entries);
  } catch (error) {
    console.warn("Failed to retrieve tool history.", error);
    return null;
  }
}

export async function retrieveWorkspaceHistory(limit = 5) {
  try {
    const entries = await listIdleWorkspaceSummaries(limit);
    if (entries.length === 0) {
      return null;
    }
    return entries
      .map((entry) => {
        const summary =
          entry.summary?.trim() ||
          entry.finalThought?.trim() ||
          entry.thoughtText.trim();
        return `${new Date(entry.createdAt).toISOString()} - ${entry.status}: ${summary}`;
      })
      .join("\n");
  } catch (error) {
    console.warn("Failed to retrieve workspace history.", error);
    return null;
  }
}

export function injectToolHistory(
  messages: ChatMessage[],
  history: string
): ChatMessage[] {
  if (!history || history === "None") {
    return messages;
  }

  const block = `Recent activity (rolling log of last tool uses and idle thoughts):\n${history}`;

  const systemIndex = messages.findIndex((message) => message.role === "system");
  if (systemIndex === -1) {
    return [{ role: "system", content: block }, ...messages];
  }

  const updated = [...messages];
  const current = updated[systemIndex];
  updated[systemIndex] = {
    ...current,
    content: `${current.content}\n\n${block}`,
  } as ChatMessage;
  return updated;
}

export function injectWorkspaceHistory(
  messages: ChatMessage[],
  history: string
): ChatMessage[] {
  if (!history) {
    return messages;
  }

  const block = `Recent idle workspace summaries:\n${history}`;

  const systemIndex = messages.findIndex((message) => message.role === "system");
  if (systemIndex === -1) {
    return [{ role: "system", content: block }, ...messages];
  }

  const updated = [...messages];
  const current = updated[systemIndex];
  updated[systemIndex] = {
    ...current,
    content: `${current.content}\n\n${block}`,
  } as ChatMessage;
  return updated;
}

export function injectWebSessionContext(
  messages: ChatMessage[],
  context: string
): ChatMessage[] {
  if (!context) {
    return messages;
  }

  const systemIndex = messages.findIndex((message) => message.role === "system");
  if (systemIndex === -1) {
    return [{ role: "system", content: context }, ...messages];
  }

  const updated = [...messages];
  const current = updated[systemIndex];
  updated[systemIndex] = {
    ...current,
    content: `${current.content}\n\n${context}`,
  } as ChatMessage;
  return updated;
}

export function injectWebArtifactContext(
  messages: ChatMessage[],
  context: string
): ChatMessage[] {
  if (!context) {
    return messages;
  }

  const systemIndex = messages.findIndex((message) => message.role === "system");
  if (systemIndex === -1) {
    return [{ role: "system", content: context }, ...messages];
  }

  const updated = [...messages];
  const current = updated[systemIndex];
  updated[systemIndex] = {
    ...current,
    content: `${current.content}\n\n${context}`,
  } as ChatMessage;
  return updated;
}

export function applyTokenGuard(
  messages: ChatMessage[],
  limit: number
): ChatMessage[] {
  if (limit <= 0) {
    return messages;
  }

  const systemIndex = messages.findIndex((message) => message.role === "system");
  const systemMessage = systemIndex >= 0 ? messages[systemIndex] : null;
  const rest = messages.filter((_, index) => index !== systemIndex);

  const kept: ChatMessage[] = [];
  let totalTokens = systemMessage ? estimateTokens(systemMessage.content) : 0;

  for (let i = rest.length - 1; i >= 0; i -= 1) {
    const message = rest[i];
    const messageTokens = estimateTokens(message.content);
    if (totalTokens + messageTokens > limit && kept.length > 0) {
      continue;
    }
    kept.unshift(message);
    totalTokens += messageTokens;
  }

  return systemMessage ? [systemMessage, ...kept] : kept;
}
