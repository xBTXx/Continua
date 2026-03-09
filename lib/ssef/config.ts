import path from "node:path";
import { resolveWorkspaceRoot } from "@/lib/file";

const DEFAULT_SSEF_ROOT_DIR = ".ssef";
const DEFAULT_FORGE_MAX_ATTEMPTS = 3;
const DEFAULT_SANDBOX_TIMEOUT_MS = 20_000;
const DEFAULT_SANDBOX_MAX_OUTPUT_CHARS = 24_000;
const DEFAULT_SANDBOX_MAX_MEMORY_MB = 512;
const DEFAULT_SANDBOX_MAX_CPU_SECONDS = 60;
const DEFAULT_SANDBOX_MAX_PROCESS_SPAWNS = 3;
const DEFAULT_RUNTIME_CHAT_MAX_TOOLS = 8;
const DEFAULT_RUNTIME_IDLE_MAX_TOOLS = 6;
const DEFAULT_RUNTIME_SELECTION_MIN_SCORE = 0.14;
const DEFAULT_RUNTIME_SELECTION_MAX_QUERY_TOKENS = 24;
const DEFAULT_DEPENDENCY_INSTALL_TIMEOUT_MS = 180_000;
const DEFAULT_RUNTIME_AUTO_INSTALL_DEPENDENCIES = true;
const DEFAULT_SSEF_FORGE_MODEL_CATALOG = [
  "openai/gpt-5.3-codex",
  "anthropic/claude-sonnet-4.6",
  "z-ai/glm-5",
  "google/gemini-3-flash-preview",
] as const;

export const SSEF_FORGE_REASONING_EFFORTS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "minimal",
] as const;

export type SSEFForgeReasoningEffort = (typeof SSEF_FORGE_REASONING_EFFORTS)[number];

const DEFAULT_SSEF_FORGE_REASONING_EFFORT: SSEFForgeReasoningEffort = "high";

export type SSEFConfig = {
  enabled: boolean;
  workspaceRoot: string;
  rootDir: string;
  registryDir: string;
  vaultDir: string;
  forgeDir: string;
  sandboxDir: string;
  skillsIndexPath: string;
  integrityHashesPath: string;
  limits: {
    forgeMaxAttempts: number;
    sandboxTimeoutMs: number;
    sandboxMaxOutputChars: number;
    sandboxMaxMemoryMb: number;
    sandboxMaxCpuSeconds: number;
    sandboxMaxProcessSpawns: number;
  };
  runtimeSelection: {
    chatMaxTools: number;
    idleMaxTools: number;
    minScore: number;
    maxQueryTokens: number;
  };
  forgeGeneration: {
    modelCatalog: string[];
    defaultModel: string;
    defaultReasoningEffort: SSEFForgeReasoningEffort;
  };
  dependencyManagement: {
    installTimeoutMs: number;
    runtimeAutoInstall: boolean;
  };
};

function parseEnvNumber(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
) {
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function parseEnvFloat(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
) {
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function parseEnvBoolean(raw: string | undefined, fallback: boolean) {
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }
  return fallback;
}

function parseEnvList(raw: string | undefined) {
  if (!raw || raw.trim().length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const values: string[] = [];
  raw
    .split(/[\r\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .forEach((entry) => {
      if (!seen.has(entry)) {
        seen.add(entry);
        values.push(entry);
      }
    });
  return values;
}

function normalizeForgeReasoningEffort(
  raw: string | undefined,
  fallback: SSEFForgeReasoningEffort
): SSEFForgeReasoningEffort {
  const normalized = raw?.trim().toLowerCase();
  if (
    normalized &&
    SSEF_FORGE_REASONING_EFFORTS.includes(
      normalized as SSEFForgeReasoningEffort
    )
  ) {
    return normalized as SSEFForgeReasoningEffort;
  }
  return fallback;
}

function resolveForgeModelCatalog() {
  const fromEnv = parseEnvList(process.env.SSEF_FORGE_MODELS);
  if (fromEnv.length > 0) {
    return fromEnv;
  }
  return [...DEFAULT_SSEF_FORGE_MODEL_CATALOG];
}

function resolveDefaultForgeModel(catalog: string[]) {
  const preferred = process.env.SSEF_FORGE_DEFAULT_MODEL?.trim();
  if (preferred && preferred.length > 0) {
    if (!catalog.includes(preferred)) {
      catalog.unshift(preferred);
    }
    return preferred;
  }
  return catalog[0] ?? DEFAULT_SSEF_FORGE_MODEL_CATALOG[0];
}

function ensurePathWithinRoot(root: string, target: string, label: string) {
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (target !== root && !target.startsWith(rootWithSep)) {
    throw new Error(`${label} must resolve inside the workspace root.`);
  }
}

function resolveSSEFRootDir(workspaceRoot: string) {
  const raw = process.env.SSEF_ROOT_DIR?.trim();
  const relative = raw ? raw.replace(/^[\\/]+/, "") : DEFAULT_SSEF_ROOT_DIR;
  const normalized = relative.length > 0 ? relative : DEFAULT_SSEF_ROOT_DIR;
  const resolved = path.resolve(workspaceRoot, normalized);
  ensurePathWithinRoot(workspaceRoot, resolved, "SSEF_ROOT_DIR");
  return resolved;
}

export function ssefEnabled() {
  return process.env.SSEF_ENABLED !== "false";
}

export function getSSEFConfig(): SSEFConfig {
  const enabled = ssefEnabled();
  const workspaceRoot = resolveWorkspaceRoot();
  const rootDir = resolveSSEFRootDir(workspaceRoot);
  const registryDir = path.join(rootDir, "registry");
  const vaultDir = path.join(rootDir, "vault");
  const forgeDir = path.join(rootDir, "forge");
  const sandboxDir = path.join(rootDir, "sandbox");
  const forgeModelCatalog = resolveForgeModelCatalog();
  const defaultForgeModel = resolveDefaultForgeModel(forgeModelCatalog);
  const defaultReasoningEffort = normalizeForgeReasoningEffort(
    process.env.SSEF_FORGE_DEFAULT_REASONING_EFFORT,
    DEFAULT_SSEF_FORGE_REASONING_EFFORT
  );

  return {
    enabled,
    workspaceRoot,
    rootDir,
    registryDir,
    vaultDir,
    forgeDir,
    sandboxDir,
    skillsIndexPath: path.join(registryDir, "skills_index.json"),
    integrityHashesPath: path.join(registryDir, "integrity_hashes.json"),
    limits: {
      forgeMaxAttempts: parseEnvNumber(
        process.env.SSEF_FORGE_MAX_ATTEMPTS,
        DEFAULT_FORGE_MAX_ATTEMPTS,
        1,
        20
      ),
      sandboxTimeoutMs: parseEnvNumber(
        process.env.SSEF_SANDBOX_TIMEOUT_MS,
        DEFAULT_SANDBOX_TIMEOUT_MS,
        1_000,
        600_000
      ),
      sandboxMaxOutputChars: parseEnvNumber(
        process.env.SSEF_SANDBOX_MAX_OUTPUT_CHARS,
        DEFAULT_SANDBOX_MAX_OUTPUT_CHARS,
        1_000,
        500_000
      ),
      sandboxMaxMemoryMb: parseEnvNumber(
        process.env.SSEF_SANDBOX_MAX_MEMORY_MB,
        DEFAULT_SANDBOX_MAX_MEMORY_MB,
        16,
        16_384
      ),
      sandboxMaxCpuSeconds: parseEnvNumber(
        process.env.SSEF_SANDBOX_MAX_CPU_SECONDS,
        DEFAULT_SANDBOX_MAX_CPU_SECONDS,
        1,
        86_400
      ),
      sandboxMaxProcessSpawns: parseEnvNumber(
        process.env.SSEF_SANDBOX_MAX_PROCESS_SPAWNS,
        DEFAULT_SANDBOX_MAX_PROCESS_SPAWNS,
        1,
        64
      ),
    },
    runtimeSelection: {
      chatMaxTools: parseEnvNumber(
        process.env.SSEF_RUNTIME_CHAT_MAX_TOOLS,
        DEFAULT_RUNTIME_CHAT_MAX_TOOLS,
        1,
        64
      ),
      idleMaxTools: parseEnvNumber(
        process.env.SSEF_RUNTIME_IDLE_MAX_TOOLS,
        DEFAULT_RUNTIME_IDLE_MAX_TOOLS,
        1,
        64
      ),
      minScore: parseEnvFloat(
        process.env.SSEF_RUNTIME_SELECTION_MIN_SCORE,
        DEFAULT_RUNTIME_SELECTION_MIN_SCORE,
        0,
        1
      ),
      maxQueryTokens: parseEnvNumber(
        process.env.SSEF_RUNTIME_SELECTION_MAX_QUERY_TOKENS,
        DEFAULT_RUNTIME_SELECTION_MAX_QUERY_TOKENS,
        4,
        200
      ),
    },
    forgeGeneration: {
      modelCatalog: forgeModelCatalog,
      defaultModel: defaultForgeModel,
      defaultReasoningEffort: defaultReasoningEffort,
    },
    dependencyManagement: {
      installTimeoutMs: parseEnvNumber(
        process.env.SSEF_DEPENDENCY_INSTALL_TIMEOUT_MS,
        DEFAULT_DEPENDENCY_INSTALL_TIMEOUT_MS,
        5_000,
        1_800_000
      ),
      runtimeAutoInstall: parseEnvBoolean(
        process.env.SSEF_RUNTIME_AUTO_INSTALL_DEPENDENCIES,
        DEFAULT_RUNTIME_AUTO_INSTALL_DEPENDENCIES
      ),
    },
  };
}
