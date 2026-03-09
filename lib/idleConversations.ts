import { randomUUID } from "node:crypto";
import { ensureSchema, query } from "./db";
import type { IdleAction } from "./idleActions";

type IdleConversationResult = {
  conversationId: string;
  messageId: string;
  title: string;
  content: string;
};

function buildConversationTitle(text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return "Idle outreach";
  }
  return trimmed.length > 48 ? `${trimmed.slice(0, 48)}...` : trimmed;
}

function buildIdleConversationMessage(thoughtText: string, action: IdleAction) {
  const lines = [
    "I started this conversation during idle time.",
    `Thought: ${thoughtText}`,
    action.rationale ? `Reason: ${action.rationale}` : null,
  ].filter(Boolean);

  const preface = lines.join("\n");
  const body =
    action.content?.trim() ||
    "Would you like to talk about this thought?";

  return `${preface}\n\n${body}`;
}

export async function createIdleConversation({
  thoughtText,
  action,
}: {
  thoughtText: string;
  action: IdleAction;
}): Promise<IdleConversationResult> {
  await ensureSchema();
  const conversationId = randomUUID();
  const title = buildConversationTitle(action.content ?? thoughtText);
  const messageId = randomUUID();
  const content = buildIdleConversationMessage(thoughtText, action);

  await query(
    `
      INSERT INTO conversations (id, title)
      VALUES ($1, $2)
    `,
    [conversationId, title]
  );
  await query(
    `
      INSERT INTO messages (id, conversation_id, role, content)
      VALUES ($1, $2, $3, $4)
    `,
    [messageId, conversationId, "assistant", content]
  );
  await query(
    `
      UPDATE conversations
      SET updated_at = NOW()
      WHERE id = $1
    `,
    [conversationId]
  );

  return { conversationId, messageId, title, content };
}
