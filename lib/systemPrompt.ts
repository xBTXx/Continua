import { ensureSchema, query } from "./db";
import { DEFAULT_SYSTEM_PROMPT } from "./systemPromptDefaults";

const SYSTEM_PROMPT_KEY = "system_prompt";
const CACHE_TTL_MS = 60 * 1000;
const CACHE_KEY = "__assistantSystemPromptCache";

type SystemPromptCache = {
  value: string;
  loadedAt: number;
};

function getCache() {
  const scope = globalThis as typeof globalThis & {
    [CACHE_KEY]?: SystemPromptCache;
  };
  return scope;
}

function readCache() {
  const scope = getCache();
  const cached = scope[CACHE_KEY];
  if (!cached) {
    return null;
  }
  if (Date.now() - cached.loadedAt > CACHE_TTL_MS) {
    return null;
  }
  return cached.value;
}

function writeCache(value: string) {
  const scope = getCache();
  scope[CACHE_KEY] = { value, loadedAt: Date.now() };
}

export async function getSystemPrompt(): Promise<string> {
  const cached = readCache();
  if (cached) {
    return cached;
  }

  await ensureSchema();
  const result = await query<{ value: string }>(
    "SELECT value FROM app_settings WHERE key = $1 LIMIT 1",
    [SYSTEM_PROMPT_KEY]
  );
  const stored = result.rows[0]?.value;
  const value =
    typeof stored === "string" && stored.trim().length > 0
      ? stored
      : DEFAULT_SYSTEM_PROMPT;
  writeCache(value);
  return value;
}

export async function setSystemPrompt(value: string) {
  const trimmed = value.trim();
  const nextValue = trimmed.length > 0 ? trimmed : DEFAULT_SYSTEM_PROMPT;
  await ensureSchema();
  await query(
    `
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `,
    [SYSTEM_PROMPT_KEY, nextValue]
  );
  writeCache(nextValue);
  return { status: "ok" as const };
}
