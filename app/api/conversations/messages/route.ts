import { randomUUID } from "node:crypto";
import { ensureSchema, query } from "@/lib/db";
import {
  computeAttachmentExpiry,
  normalizeAttachments,
} from "@/lib/chatAttachments";
import { attachChatInjectionToMessage } from "@/lib/chatInjections";
import { recordIdleActivity, startIdleScheduler } from "@/lib/idleState";
import {
  consumeScratchpadNotes,
  countAssistantMessages,
  SCRATCHPAD_ASSISTANT_WINDOW,
} from "@/lib/scratchpad";

const DEFAULT_TITLE = "New conversation";

type MessageRow = {
  id: string;
  role: string;
  content: string;
  created_at: string;
  attachments?: unknown;
};

function mapMessage(row: MessageRow) {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  };
}

export async function POST(request: Request) {
  try {
    await startIdleScheduler();
    await ensureSchema();
    const payload = (await request.json().catch(() => ({}))) as {
      conversationId?: string;
      role?: string;
      content?: string;
      attachments?: unknown;
      injectionId?: string;
    };

    const conversationId =
      typeof payload.conversationId === "string" ? payload.conversationId : "";
    const role =
      payload.role === "user" || payload.role === "assistant"
        ? payload.role
        : null;
    const content =
      typeof payload.content === "string" ? payload.content.trim() : "";
    const injectionId =
      typeof payload.injectionId === "string" ? payload.injectionId.trim() : "";
    const expiresAt = computeAttachmentExpiry();
    const attachments = normalizeAttachments(payload.attachments, expiresAt);

    if (!conversationId || !role || (!content && attachments.length === 0)) {
      return new Response("Invalid message payload.", { status: 400 });
    }
    if (role === "user") {
      recordIdleActivity("conversation_message");
    }

    const conversationResult = await query<{ id: string; title: string }>(
      `
        SELECT id, title
        FROM conversations
        WHERE id = $1 AND archived_at IS NULL
        LIMIT 1
      `,
      [conversationId]
    );

    if (conversationResult.rows.length === 0) {
      return new Response("Conversation not found.", { status: 404 });
    }

    const messageId = randomUUID();
    const inserted = await query<MessageRow>(
      `
        INSERT INTO messages (id, conversation_id, role, content, attachments, attachments_expires_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, role, content, created_at, attachments
      `,
      [
        messageId,
        conversationId,
        role,
        content,
        attachments.length > 0 ? JSON.stringify(attachments) : null,
        attachments.length > 0 ? expiresAt.toISOString() : null,
      ]
    );

    if (role === "assistant" && injectionId) {
      try {
        await attachChatInjectionToMessage({
          injectionId,
          messageId,
          conversationId,
        });
      } catch (error) {
        console.warn("Failed to attach chat injection log.", error);
      }
    }

    if (role === "assistant") {
      try {
        const assistantCount = await countAssistantMessages(conversationId);
        if (assistantCount >= SCRATCHPAD_ASSISTANT_WINDOW) {
          await consumeScratchpadNotes(conversationId);
        }
      } catch (error) {
        console.warn("Scratchpad consumption failed.", error);
      }
    }

    await query(
      `
        UPDATE conversations
        SET updated_at = NOW()
        WHERE id = $1
      `,
      [conversationId]
    );

    const conversation = conversationResult.rows[0];
    if (role === "user" && conversation.title === DEFAULT_TITLE) {
      const nextTitle = content.length > 48 ? `${content.slice(0, 48)}…` : content;
      await query(
        `
          UPDATE conversations
          SET title = $1
          WHERE id = $2
        `,
        [nextTitle, conversationId]
      );
    }

    return Response.json({
      ...mapMessage(inserted.rows[0]),
      attachments,
      injectionId: injectionId || null,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected error";
    return new Response(message, { status: 500 });
  }
}
