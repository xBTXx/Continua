import { randomUUID } from "node:crypto";
import { ensureSchema, query } from "./db";

type ReplyStatus = {
  count: number;
  lastRepliedAt: string;
};

function normalizeText(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

export async function recordEmailReplyDraft({
  accountId,
  draftId,
  messageId,
  source,
}: {
  accountId: string;
  draftId: string;
  messageId: string;
  source?: string | null;
}) {
  const account = normalizeText(accountId);
  const draft = normalizeText(draftId);
  const message = normalizeText(messageId);
  if (!account || !draft || !message) {
    return { status: "skipped" as const };
  }

  await ensureSchema();
  await query(
    `
      INSERT INTO email_reply_log (id, account_id, action_type, message_id, draft_id, source)
      VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [randomUUID(), account, "draft_reply", message, draft, source ?? null]
  );
  return { status: "ok" as const };
}

export async function recordEmailReplySent({
  accountId,
  messageId,
  draftId,
  source,
}: {
  accountId: string;
  messageId: string;
  draftId?: string | null;
  source?: string | null;
}) {
  const account = normalizeText(accountId);
  const message = normalizeText(messageId);
  const draft = normalizeText(draftId);
  if (!account || !message) {
    return { status: "skipped" as const };
  }

  await ensureSchema();
  await query(
    `
      INSERT INTO email_reply_log (id, account_id, action_type, message_id, draft_id, source)
      VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [randomUUID(), account, "reply", message, draft || null, source ?? null]
  );
  return { status: "ok" as const };
}

export async function findReplyTargetForDraft(
  accountId: string,
  draftId: string
) {
  const account = normalizeText(accountId);
  const draft = normalizeText(draftId);
  if (!account || !draft) {
    return null;
  }

  await ensureSchema();
  const result = await query<{ message_id: string }>(
    `
      SELECT message_id
      FROM email_reply_log
      WHERE account_id = $1
        AND draft_id = $2
        AND action_type = 'draft_reply'
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [account, draft]
  );

  if (result.rows.length === 0) {
    return null;
  }
  return result.rows[0]?.message_id ?? null;
}

export async function getEmailReplyStatus(
  accountId: string,
  messageIds: string[]
) {
  const account = normalizeText(accountId);
  const ids = messageIds
    .map((entry) => normalizeText(entry))
    .filter((entry) => entry.length > 0);
  if (!account || ids.length === 0) {
    return new Map<string, ReplyStatus>();
  }

  await ensureSchema();
  const result = await query<{
    message_id: string;
    reply_count: number;
    last_replied_at: string;
  }>(
    `
      SELECT message_id,
             COUNT(*)::int AS reply_count,
             MAX(created_at) AS last_replied_at
      FROM email_reply_log
      WHERE account_id = $1
        AND action_type = 'reply'
        AND message_id = ANY($2::text[])
      GROUP BY message_id
    `,
    [account, ids]
  );

  const map = new Map<string, ReplyStatus>();
  for (const row of result.rows) {
    if (!row.message_id) {
      continue;
    }
    map.set(row.message_id, {
      count: Number(row.reply_count) || 0,
      lastRepliedAt: row.last_replied_at,
    });
  }
  return map;
}
