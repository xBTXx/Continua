import { ensureSchema, query } from "./db";

const IDLE_ENABLED_KEY = "idle_enabled";
const CACHE_TTL_MS = 60 * 1000;
const CACHE_KEY = "__assistantIdleEnabledCache";

type IdleEnabledCache = {
  value: boolean | null;
  loadedAt: number;
};

function getCacheScope() {
  return globalThis as typeof globalThis & {
    [CACHE_KEY]?: IdleEnabledCache;
  };
}

function readCache() {
  const scope = getCacheScope();
  const cached = scope[CACHE_KEY];
  if (!cached) {
    return undefined;
  }
  if (Date.now() - cached.loadedAt > CACHE_TTL_MS) {
    return undefined;
  }
  return cached.value;
}

function writeCache(value: boolean | null) {
  const scope = getCacheScope();
  scope[CACHE_KEY] = { value, loadedAt: Date.now() };
}

function parseIdleEnabled(value: string | undefined) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return null;
}

export async function getIdleEnabledSetting(): Promise<boolean | null> {
  const cached = readCache();
  if (cached !== undefined) {
    return cached;
  }

  await ensureSchema();
  const result = await query<{ value: string }>(
    "SELECT value FROM app_settings WHERE key = $1 LIMIT 1",
    [IDLE_ENABLED_KEY]
  );
  const parsed = parseIdleEnabled(result.rows[0]?.value);
  writeCache(parsed);
  return parsed;
}

export async function setIdleEnabledSetting(enabled: boolean) {
  const value = enabled ? "true" : "false";
  await ensureSchema();
  await query(
    `
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `,
    [IDLE_ENABLED_KEY, value]
  );
  writeCache(enabled);
  return { status: "ok" as const };
}
