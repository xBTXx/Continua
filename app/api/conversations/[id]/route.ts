import { randomUUID } from "node:crypto";
import { ensureSchema, query } from "@/lib/db";
import { filterExpiredAttachments } from "@/lib/chatAttachments";
import type { ImageAttachment } from "@/types/chat";

const DEFAULT_TITLE = "New conversation";

type ConversationRow = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  last_message_at?: string | null;
};

type MessageRow = {
  id: string;
  role: string;
  content: string;
  created_at: string;
  injection_id?: string | null;
  attachments?: unknown;
  attachments_expires_at?: string | null;
};

function mapConversation(row: ConversationRow) {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastMessageAt: row.last_message_at ?? null,
  };
}

function mapMessage(row: MessageRow) {
  let attachments: ImageAttachment[] = [];
  if (row.attachments) {
    try {
      const raw =
        typeof row.attachments === "string"
          ? JSON.parse(row.attachments)
          : row.attachments;
      if (Array.isArray(raw)) {
        attachments = filterExpiredAttachments(
          raw as ImageAttachment[],
          row.attachments_expires_at ?? null
        );
      }
    } catch {
      attachments = [];
    }
  }
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    attachments,
    createdAt: row.created_at,
    injectionId: row.injection_id ?? null,
  };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await ensureSchema();
    const conversationResult = await query<ConversationRow>(
      `
        SELECT id,
               title,
               created_at,
               updated_at,
               archived_at,
               (
                 SELECT MAX(messages.created_at)
                 FROM messages
                 WHERE messages.conversation_id = conversations.id
               ) AS last_message_at
        FROM conversations
        WHERE id = $1
        LIMIT 1
      `,
      [id]
    );

    const conversation = conversationResult.rows[0];
    if (!conversation || conversation.archived_at) {
      return new Response("Conversation not found.", { status: 404 });
    }

    const messagesResult = await query<MessageRow>(
      `
        SELECT messages.id,
               messages.role,
               messages.content,
               messages.attachments,
               messages.attachments_expires_at,
               messages.created_at,
               chat_injection_log.id AS injection_id
        FROM messages
        LEFT JOIN chat_injection_log
          ON chat_injection_log.message_id = messages.id
        WHERE messages.conversation_id = $1
        ORDER BY messages.created_at ASC
      `,
      [id]
    );

    return Response.json({
      conversation: mapConversation(conversation),
      messages: messagesResult.rows.map(mapMessage),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected error";
    return new Response(message, { status: 500 });
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await ensureSchema();
    const payload = (await request.json().catch(() => ({}))) as {
      title?: string;
      archived?: boolean;
    };

    if (typeof payload.title === "string") {
      const title = payload.title.trim();
      if (!title) {
        return new Response("Title cannot be empty.", { status: 400 });
      }
      await query(
        `
          UPDATE conversations
          SET title = $1, updated_at = NOW()
          WHERE id = $2
        `,
        [title, id]
      );
    }

    if (payload.archived === true) {
      await query(
        `
          UPDATE conversations
          SET archived_at = NOW()
          WHERE id = $1
        `,
        [id]
      );
    }

    return new Response(null, { status: 204 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected error";
    return new Response(message, { status: 500 });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await ensureSchema();
    const payload = (await request.json().catch(() => ({}))) as {
      role?: string;
      content?: string;
    };

    const role =
      payload.role === "user" || payload.role === "assistant"
        ? payload.role
        : null;
    const content =
      typeof payload.content === "string" ? payload.content.trim() : "";

    if (!role || !content) {
      return new Response("Invalid message payload.", { status: 400 });
    }

    const conversationResult = await query<{ id: string; title: string }>(
      `
        SELECT id, title
        FROM conversations
        WHERE id = $1 AND archived_at IS NULL
        LIMIT 1
      `,
      [id]
    );

    if (conversationResult.rows.length === 0) {
      return new Response("Conversation not found.", { status: 404 });
    }

    const messageId = randomUUID();
    const inserted = await query<MessageRow>(
      `
        INSERT INTO messages (id, conversation_id, role, content)
        VALUES ($1, $2, $3, $4)
        RETURNING id, role, content, created_at
      `,
      [messageId, id, role, content]
    );

    await query(
      `
        UPDATE conversations
        SET updated_at = NOW()
        WHERE id = $1
      `,
      [id]
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
        [nextTitle, id]
      );
    }

    return Response.json(mapMessage(inserted.rows[0]));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected error";
    return new Response(message, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await ensureSchema();
    await query(
      `
        UPDATE conversations
        SET archived_at = NOW()
        WHERE id = $1
      `,
      [id]
    );
    return new Response(null, { status: 204 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected error";
    return new Response(message, { status: 500 });
  }
}
