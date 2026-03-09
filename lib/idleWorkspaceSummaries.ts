import { ensureSchema, query } from "./db";

export async function listIdleWorkspaceSummaries(limit: number) {
  const safeLimit = Math.min(50, Math.max(1, Math.floor(limit)));
  await ensureSchema();
  const result = await query<{
    id: string;
    thought_text: string;
    final_thought: string | null;
    summary: string | null;
    status: string;
    created_at: string;
  }>(
    `
      SELECT id, thought_text, final_thought, summary, status, created_at
      FROM idle_workspace_sessions
      ORDER BY created_at DESC
      LIMIT $1
    `,
    [safeLimit]
  );

  return result.rows.map((row) => ({
    id: row.id,
    thoughtText: row.thought_text,
    finalThought: row.final_thought ?? undefined,
    summary: row.summary ?? undefined,
    status: row.status,
    createdAt: row.created_at,
  }));
}
