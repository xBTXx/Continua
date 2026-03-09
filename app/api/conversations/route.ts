import { randomUUID } from "node:crypto";
import { ensureSchema, query } from "@/lib/db";

type ConversationRow = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  last_message_at?: string | null;
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

export async function GET() {
  try {
    await ensureSchema();
    const result = await query<ConversationRow>(
      `
        SELECT id,
               title,
               created_at,
               updated_at,
               (
                 SELECT MAX(messages.created_at)
                 FROM messages
                 WHERE messages.conversation_id = conversations.id
               ) AS last_message_at
        FROM conversations
        WHERE archived_at IS NULL
        ORDER BY updated_at DESC
      `
    );

    return Response.json(result.rows.map(mapConversation));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected error";
    return new Response(message, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    await ensureSchema();
    const payload = (await request.json().catch(() => ({}))) as {
      title?: string;
    };
    const title =
      typeof payload.title === "string" && payload.title.trim().length > 0
        ? payload.title.trim()
        : "New conversation";
    const id = randomUUID();

    const result = await query<ConversationRow>(
      `
        INSERT INTO conversations (id, title)
        VALUES ($1, $2)
        RETURNING id, title, created_at, updated_at
      `,
      [id, title]
    );

    return Response.json(mapConversation(result.rows[0]));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected error";
    return new Response(message, { status: 500 });
  }
}
