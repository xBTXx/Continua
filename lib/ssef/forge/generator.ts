import fs from "node:fs/promises";
import path from "node:path";
import { createChatCompletion } from "@/lib/openrouter";
import {
  validateSkillManifestV1,
  type SkillManifestV1,
} from "../contracts/manifest";
import {
  getSSEFConfig,
  SSEF_FORGE_REASONING_EFFORTS,
  type SSEFForgeReasoningEffort,
} from "../config";
import {
  getSSEFSkillBySkillId,
  getSSEFSkillVersionBySkillAndVersion,
  type SSEFProposal,
} from "../repository";
import {
  readSSEFProposalUpgradeTarget,
  type SSEFVersionBump,
} from "../proposals/upgrade";
import {
  buildSSEFForgePromptContract,
  SSEF_FORGE_PROMPT_CONTRACT_VERSION,
} from "../templates/promptContract";

const MAX_SKILL_ID_LENGTH = 64;
const DEFAULT_INITIAL_VERSION = "0.1.0";
const DEFAULT_PRIORITY = "medium";
const DEFAULT_FORGE_MODEL_TEMPERATURE = 0.2;
const MAX_ENTRYPOINT_CHARS = 180_000;
const MAX_MODEL_RESPONSE_PREVIEW_CHARS = 1_200;
const MAX_GENERATED_TEST_CASES = 12;
const MAX_AUTO_SKILL_NAME_TOKENS = 6;
const MAX_AUTO_SKILL_ID_TOKENS = 8;
const MAX_VERSION_RESOLUTION_ATTEMPTS = 24;
const MAX_WORKSPACE_EDITS = 40;
const MAX_WORKSPACE_PATH_LENGTH = 180;
const MAX_WORKSPACE_STRING_VALUE_CHARS = 80_000;
const MAX_UPGRADE_PROMPT_FILE_CHARS = 12_000;

const SKILL_NAME_STOP_WORDS = new Set<string>([
  "a",
  "an",
  "and",
  "allows",
  "allow",
  "as",
  "at",
  "be",
  "by",
  "capability",
  "create",
  "creates",
  "craft",
  "execute",
  "for",
  "from",
  "functional",
  "helps",
  "i",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "standard",
  "that",
  "the",
  "this",
  "to",
  "tool",
  "tools",
  "use",
  "using",
  "with",
]);

const UPPERCASE_SKILL_NAME_TOKENS = new Set<string>([
  "ai",
  "api",
  "cli",
  "cpu",
  "csv",
  "dns",
  "ftp",
  "html",
  "http",
  "https",
  "id",
  "ip",
  "json",
  "jwt",
  "llm",
  "pdf",
  "rss",
  "sdk",
  "smtp",
  "sql",
  "ssh",
  "tcp",
  "tls",
  "udp",
  "ui",
  "url",
  "uuid",
  "xml",
]);

const FORGE_GENERATOR_SYSTEM_PROMPT = [
  "You are the SSEF Forge, a code generator for production-ready tool skills.",
  "Return ONLY valid JSON. No markdown fences, no commentary outside JSON.",
  "Generate artifacts that satisfy SkillManifestV1 and run as a Node skill.",
  "Entrypoint constraints:",
  "- Must read JSON from stdin.",
  "- Input shape: { args: object, _context: object }.",
  "- Must print exactly one JSON object to stdout on success.",
  "- On fatal failure, write to stderr and exit non-zero.",
  "- If third-party libraries are required, declare them in manifest.runtime_dependencies.",
  "Safety constraints:",
  "- Use least-privilege permissions.",
  "- Avoid wildcard process commands.",
  "- Keep behavior deterministic for provided tests where possible.",
  "- Keep tests generic, simple, and stable across skill categories.",
  "- Do not rely on live internet access in tests.",
  "- Avoid brittle assertions on exact prose in summary fields.",
  "Output JSON contract:",
  "{",
  '  "manifest": { ... SkillManifestV1 object ... },',
  '  "entrypoint_file": "entrypoint.js",',
  '  "entrypoint_code": "<javascript source>",',
  '  // Optional for upgrade mode: deterministic surgical edits against baseline workspace files.',
  '  "workspace_edits": [',
  "    { op: \"replace\", path: \"entrypoint.js\", find: \"old\", replace: \"new\", occurrence: \"unique\" }",
  "  ],",
  '  // Optional manifest.runtime_dependencies shape:',
  '  // "runtime_dependencies": { "npm": ["package@1.2.3"], "pip": ["ddgs>=8.1.0"] }',
  '  "test_cases": [',
  "    {",
  '      "id": "string",',
  '      "description": "string",',
  '      "input": { ... },',
  '      "assertions": [',
  "        { kind: \"path_exists\", path: \"status\" },",
  "        { kind: \"equals\", path: \"status\", value: \"ok\" },",
  "        { kind: \"contains\", path: \"summary\", value: \"text\" },",
  "        { kind: \"array_includes\", path: \"received_input_keys\", value: \"url\" }",
  "      ]",
  "    }",
  "  ]",
  "}",
].join("\n");

export type SSEFForgeTestCaseAssertion =
  | {
      kind: "path_exists";
      path: string;
    }
  | {
      kind: "equals";
      path: string;
      value: string | number | boolean | null;
    }
  | {
      kind: "contains";
      path: string;
      value: string;
    }
  | {
      kind: "array_includes";
      path: string;
      value: string | number | boolean | null;
    };

export type SSEFForgeTestCase = {
  id: string;
  description: string;
  input: Record<string, unknown>;
  assertions: SSEFForgeTestCaseAssertion[];
};

export type SSEFForgeGenerationFeedback = {
  reasons: string[];
  sandboxDiagnostics: string[];
  criticFindings: string[];
};

export type SSEFForgeReuseSuggestion = {
  skillId: string;
  score: number;
};

export type SSEFForgeGenerationOptions = {
  model: string;
  reasoningEffort: SSEFForgeReasoningEffort;
};

export type GenerateSSEFForgeArtifactsInput = {
  proposal: SSEFProposal;
  attempt: number;
  maxAttempts: number;
  previousFeedback?: SSEFForgeGenerationFeedback | null;
  reuseCandidates?: SSEFForgeReuseSuggestion[];
  reuseReason?: string | null;
  generationOptions?: Partial<SSEFForgeGenerationOptions> | null;
};

export type SSEFForgeGeneratedArtifacts = {
  skillId: string;
  version: string;
  runtime: "node";
  promptContractVersion: string;
  promptContractText: string;
  manifest: SkillManifestV1;
  entrypointFileName: string;
  entrypointContent: string;
  testCasesFileName: string;
  testCases: SSEFForgeTestCase[];
  metadata: Record<string, unknown>;
};

type ForgeModelResponseEnvelope = {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
};

type SSEFWorkspaceEditOccurrence = "unique" | "first" | "last" | "all";

type SSEFWorkspaceEditOperation =
  | {
      op: "replace";
      path: string;
      find: string;
      replace: string;
      occurrence: SSEFWorkspaceEditOccurrence;
    }
  | {
      op: "insert_before" | "insert_after";
      path: string;
      anchor: string;
      text: string;
    }
  | {
      op: "append" | "prepend";
      path: string;
      text: string;
    }
  | {
      op: "set";
      path: string;
      content: string;
    };

type SSEFUpgradeBaselineArtifacts = {
  skillId: string;
  version: string;
  manifest: SkillManifestV1;
  entrypointFileName: string;
  entrypointContent: string;
  testCasesFileName: string;
  testCases: SSEFForgeTestCase[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function asNonEmptyText(value: unknown) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function clipText(value: string, maxChars: number) {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function toJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function clipMiddleText(value: string, maxChars: number) {
  if (value.length <= maxChars) {
    return value;
  }
  const half = Math.max(0, Math.floor((maxChars - 64) / 2));
  const head = value.slice(0, half).trimEnd();
  const tail = value.slice(Math.max(0, value.length - half)).trimStart();
  return `${head}\n/* ... trimmed ${String(value.length - (head.length + tail.length))} chars ... */\n${tail}`;
}

function normalizeWorkspacePath(value: unknown) {
  const raw = asNonEmptyText(value);
  if (!raw) {
    return "";
  }
  const withoutLeadingSlash = raw.replace(/\\/g, "/").replace(/^\/+/, "");
  const normalized = path.posix.normalize(withoutLeadingSlash);
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    return "";
  }
  return normalized.slice(0, MAX_WORKSPACE_PATH_LENGTH);
}

function normalizeWorkspaceOccurrence(value: unknown): SSEFWorkspaceEditOccurrence {
  const normalized = asNonEmptyText(value).toLowerCase();
  if (
    normalized === "unique" ||
    normalized === "first" ||
    normalized === "last" ||
    normalized === "all"
  ) {
    return normalized;
  }
  return "unique";
}

function asBoundedText(value: unknown) {
  const text = asNonEmptyText(value);
  if (!text) {
    return "";
  }
  return text.slice(0, MAX_WORKSPACE_STRING_VALUE_CHARS);
}

function normalizeWorkspaceEdits(value: unknown): SSEFWorkspaceEditOperation[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const operations: SSEFWorkspaceEditOperation[] = [];
  value.slice(0, MAX_WORKSPACE_EDITS).forEach((rawOp) => {
    if (!isRecord(rawOp)) {
      return;
    }
    const op = asNonEmptyText(rawOp.op ?? rawOp.kind ?? rawOp.type).toLowerCase();
    const targetPath = normalizeWorkspacePath(rawOp.path ?? rawOp.file ?? rawOp.target);
    if (!op || !targetPath) {
      return;
    }

    if (op === "replace") {
      const find = asBoundedText(rawOp.find ?? rawOp.search ?? rawOp.match);
      if (!find) {
        return;
      }
      operations.push({
        op: "replace",
        path: targetPath,
        find,
        replace: asBoundedText(rawOp.replace ?? rawOp.with ?? rawOp.value),
        occurrence: normalizeWorkspaceOccurrence(rawOp.occurrence),
      });
      return;
    }

    if (op === "insert_before" || op === "insert_after") {
      const anchor = asBoundedText(rawOp.anchor ?? rawOp.find ?? rawOp.match);
      const text = asBoundedText(rawOp.text ?? rawOp.insert ?? rawOp.value);
      if (!anchor || !text) {
        return;
      }
      operations.push({
        op,
        path: targetPath,
        anchor,
        text,
      });
      return;
    }

    if (op === "append" || op === "prepend") {
      const text = asBoundedText(rawOp.text ?? rawOp.value ?? rawOp.content);
      if (!text) {
        return;
      }
      operations.push({
        op,
        path: targetPath,
        text,
      });
      return;
    }

    if (op === "set" || op === "replace_file") {
      const content = asBoundedText(rawOp.content ?? rawOp.text ?? rawOp.value);
      if (!content) {
        return;
      }
      operations.push({
        op: "set",
        path: targetPath,
        content,
      });
    }
  });

  return operations;
}

function countMatches(text: string, needle: string) {
  if (!needle) {
    return 0;
  }
  let count = 0;
  let offset = 0;
  while (true) {
    const index = text.indexOf(needle, offset);
    if (index === -1) {
      return count;
    }
    count += 1;
    offset = index + needle.length;
  }
}

function replaceWithOccurrence(params: {
  content: string;
  find: string;
  replace: string;
  occurrence: SSEFWorkspaceEditOccurrence;
}) {
  const count = countMatches(params.content, params.find);
  if (count === 0) {
    throw new Error("replace operation did not find target text.");
  }
  if (params.occurrence === "all") {
    return params.content.split(params.find).join(params.replace);
  }
  if (params.occurrence === "first") {
    return params.content.replace(params.find, params.replace);
  }
  if (params.occurrence === "last") {
    const index = params.content.lastIndexOf(params.find);
    if (index < 0) {
      throw new Error("replace operation did not find target text.");
    }
    return (
      params.content.slice(0, index) +
      params.replace +
      params.content.slice(index + params.find.length)
    );
  }
  if (count !== 1) {
    throw new Error(
      `replace operation expected unique match but found ${String(count)} occurrences.`
    );
  }
  return params.content.replace(params.find, params.replace);
}

function applyWorkspaceEdits(params: {
  files: Map<string, string>;
  operations: SSEFWorkspaceEditOperation[];
}) {
  const workspace = new Map(params.files);
  params.operations.forEach((operation, index) => {
    const filePath = operation.path;
    const existing = workspace.get(filePath);
    if (operation.op !== "set" && typeof existing !== "string") {
      throw new Error(
        `workspace_edits[${String(index)}] references missing file '${filePath}'.`
      );
    }
    const current = existing ?? "";

    if (operation.op === "set") {
      workspace.set(filePath, operation.content);
      return;
    }

    if (operation.op === "replace") {
      workspace.set(
        filePath,
        replaceWithOccurrence({
          content: current,
          find: operation.find,
          replace: operation.replace,
          occurrence: operation.occurrence,
        })
      );
      return;
    }

    if (operation.op === "append") {
      workspace.set(filePath, `${current}${operation.text}`);
      return;
    }
    if (operation.op === "prepend") {
      workspace.set(filePath, `${operation.text}${current}`);
      return;
    }
    if (operation.op !== "insert_before" && operation.op !== "insert_after") {
      return;
    }

    const anchorIndex = current.indexOf(operation.anchor);
    if (anchorIndex < 0) {
      throw new Error(
        `workspace_edits[${String(index)}] could not find anchor in '${filePath}'.`
      );
    }
    if (operation.op === "insert_before") {
      workspace.set(
        filePath,
        `${current.slice(0, anchorIndex)}${operation.text}${current.slice(anchorIndex)}`
      );
      return;
    }

    workspace.set(
      filePath,
      `${current.slice(0, anchorIndex + operation.anchor.length)}${operation.text}${current.slice(anchorIndex + operation.anchor.length)}`
    );
  });
  return workspace;
}

function parseJsonRecordFromText(value: string, label: string) {
  try {
    const parsed = JSON.parse(value);
    if (!isRecord(parsed)) {
      throw new Error(`${label} must be a JSON object.`);
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid JSON";
    throw new Error(`${label} parse failed: ${message}`);
  }
}

function buildUpgradeCompatibilityInput(
  inputSchema: Record<string, unknown>
): Record<string, unknown> {
  const properties = asRecord(inputSchema.properties);
  const keys = Object.keys(properties).slice(0, 12);
  const input: Record<string, unknown> = {};

  keys.forEach((key) => {
    const lowered = key.toLowerCase();
    if (lowered.includes("url") || lowered.includes("uri") || lowered.includes("endpoint")) {
      input[key] = "https://example.com";
      return;
    }
    if (lowered.includes("method") || lowered === "verb") {
      input[key] = "GET";
      return;
    }
    if (lowered.includes("header")) {
      input[key] = {};
      return;
    }
    if (lowered.includes("body") || lowered.includes("payload") || lowered.includes("data")) {
      input[key] = {};
      return;
    }
    if (lowered.includes("timeout") || lowered.endsWith("_ms")) {
      input[key] = 5_000;
      return;
    }
    input[key] = "example";
  });

  return input;
}

function extractInputSchemaKeys(inputSchema: Record<string, unknown>) {
  const properties = asRecord(inputSchema.properties);
  return Object.keys(properties);
}

async function readUpgradeBaselineArtifacts(params: {
  skillId: string;
  version: string;
}): Promise<SSEFUpgradeBaselineArtifacts> {
  const config = getSSEFConfig();
  const versionRecord = await getSSEFSkillVersionBySkillAndVersion(
    params.skillId,
    params.version
  );
  if (!versionRecord) {
    throw new Error(
      `Upgrade baseline version '${params.skillId}@${params.version}' was not found.`
    );
  }

  const versionRoot = path.join(config.vaultDir, params.skillId, params.version);
  const entrypointFileName = normalizeEntrypointFileName(versionRecord.entrypoint);
  const testCasesFileName = normalizeWorkspacePath(
    versionRecord.testCases[0] ?? "test_cases.json"
  ) || "test_cases.json";

  const entrypointPath = path.join(versionRoot, entrypointFileName);
  const manifestPath = path.join(versionRoot, "manifest.json");
  const testCasesPath = path.join(versionRoot, testCasesFileName);

  const [entrypointContent, manifestText, testCasesText] = await Promise.all([
    fs.readFile(entrypointPath, "utf8"),
    fs.readFile(manifestPath, "utf8").catch(() => null),
    fs.readFile(testCasesPath, "utf8").catch(() => null),
  ]);

  const parsedManifest =
    manifestText && manifestText.trim().length > 0
      ? validateSkillManifestV1(parseJsonRecordFromText(manifestText, "baseline manifest"))
      : versionRecord.manifest;
  const parsedCases = testCasesText
    ? normalizeTestCases(JSON.parse(testCasesText))
    : normalizeTestCases(versionRecord.testCases);

  return {
    skillId: params.skillId,
    version: params.version,
    manifest: parsedManifest,
    entrypointFileName,
    entrypointContent,
    testCasesFileName,
    testCases: parsedCases,
  };
}

function buildUpgradeWorkspacePreview(params: {
  entrypointFileName: string;
  entrypointContent: string;
  manifest: SkillManifestV1;
  testCasesFileName: string;
  testCases: SSEFForgeTestCase[];
}) {
  const files = [
    {
      path: "manifest.json",
      content: `${JSON.stringify(params.manifest, null, 2)}\n`,
    },
    {
      path: params.entrypointFileName,
      content: params.entrypointContent,
    },
    {
      path: params.testCasesFileName,
      content: `${JSON.stringify(params.testCases, null, 2)}\n`,
    },
  ];

  return files
    .map((file) => {
      const content = clipMiddleText(file.content, MAX_UPGRADE_PROMPT_FILE_CHARS);
      return [`[FILE ${file.path}]`, content, `[END FILE ${file.path}]`].join("\n");
    })
    .join("\n\n");
}

function asSparkText(
  spark: Record<string, unknown>,
  keys: string[],
  fallback: string
) {
  for (const key of keys) {
    const text = asNonEmptyText(spark[key]);
    if (text) {
      return text;
    }
  }
  return fallback;
}

function parseListValue(value: unknown) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => asNonEmptyText(entry))
      .filter(Boolean);
  }
  if (typeof value === "string") {
    const split = value
      .split(/\r?\n|[,;]+/g)
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (split.length > 0) {
      return split;
    }
  }
  return [];
}

function asSparkList(spark: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const list = parseListValue(spark[key]);
    if (list.length > 0) {
      return list.slice(0, 20).map((entry) => clipText(entry, 180));
    }
  }
  return [] as string[];
}

function normalizePriority(spark: Record<string, unknown>) {
  const raw = asNonEmptyText(spark.priority).toLowerCase();
  if (!raw) {
    return DEFAULT_PRIORITY;
  }
  if (raw === "critical" || raw === "p0" || raw === "p1") {
    return "urgent";
  }
  if (raw === "normal") {
    return "medium";
  }
  if (raw === "low" || raw === "medium" || raw === "high" || raw === "urgent") {
    return raw;
  }
  return DEFAULT_PRIORITY;
}

function toSlug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

function enforceSkillIdConstraints(value: string) {
  let normalized = value.toLowerCase();
  if (!normalized) {
    normalized = "skill";
  }
  if (!/^[a-z]/.test(normalized)) {
    normalized = `skill-${normalized}`;
  }
  normalized = normalized.replace(/[^a-z0-9._-]+/g, "-");
  normalized = normalized.replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  if (normalized.length < 3) {
    normalized = `skill-${normalized}`.slice(0, MAX_SKILL_ID_LENGTH);
  }
  return normalized.slice(0, MAX_SKILL_ID_LENGTH);
}

function withSuffix(baseId: string, suffix: string) {
  const safeSuffix = toSlug(suffix).slice(0, 12) || "x";
  const trimmedBase = baseId.slice(
    0,
    Math.max(3, MAX_SKILL_ID_LENGTH - safeSuffix.length - 1)
  );
  return enforceSkillIdConstraints(`${trimmedBase}-${safeSuffix}`);
}

async function resolveUniqueSkillId(baseId: string, proposalId: string) {
  const direct = await getSSEFSkillBySkillId(baseId).catch(() => null);
  if (!direct) {
    return baseId;
  }

  const fallbackCandidate = withSuffix(baseId, proposalId.slice(0, 8));
  const fallback = await getSSEFSkillBySkillId(fallbackCandidate).catch(() => null);
  if (!fallback) {
    return fallbackCandidate;
  }

  for (let index = 2; index <= 20; index += 1) {
    const candidate = withSuffix(baseId, `${proposalId.slice(0, 5)}${index}`);
    const exists = await getSSEFSkillBySkillId(candidate).catch(() => null);
    if (!exists) {
      return candidate;
    }
  }

  return enforceSkillIdConstraints(`skill-${proposalId.replace(/-/g, "").slice(0, 12)}`);
}

function parseSemverTriplet(value: string) {
  const match = value
    .trim()
    .match(/^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/);
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function bumpSemver(version: string, bump: SSEFVersionBump) {
  const parsed = parseSemverTriplet(version);
  if (!parsed) {
    return DEFAULT_INITIAL_VERSION;
  }
  if (bump === "major") {
    return `${String(parsed.major + 1)}.0.0`;
  }
  if (bump === "minor") {
    return `${String(parsed.major)}.${String(parsed.minor + 1)}.0`;
  }
  return `${String(parsed.major)}.${String(parsed.minor)}.${String(parsed.patch + 1)}`;
}

async function resolveUpgradeVersion(params: {
  skillId: string;
  bump: SSEFVersionBump;
  baseVersion: string | null;
}) {
  let candidate = params.baseVersion
    ? bumpSemver(params.baseVersion, params.bump)
    : DEFAULT_INITIAL_VERSION;
  for (let attempt = 0; attempt < MAX_VERSION_RESOLUTION_ATTEMPTS; attempt += 1) {
    const existing = await getSSEFSkillVersionBySkillAndVersion(
      params.skillId,
      candidate
    );
    if (!existing) {
      return candidate;
    }
    candidate = bumpSemver(candidate, params.bump);
  }

  throw new Error(
    `Unable to resolve unique version for skill '${params.skillId}' after ${String(
      MAX_VERSION_RESOLUTION_ATTEMPTS
    )} attempts.`
  );
}

function toTitleCase(value: string) {
  return value
    .split(/\s+/g)
    .filter(Boolean)
    .map((word) => {
      const lowered = word.toLowerCase();
      if (UPPERCASE_SKILL_NAME_TOKENS.has(lowered)) {
        return lowered.toUpperCase();
      }
      return `${lowered.charAt(0).toUpperCase()}${lowered.slice(1)}`;
    })
    .join(" ");
}

function tokenizeSkillName(value: string) {
  const seen = new Set<string>();
  const tokens: string[] = [];
  value
    .toLowerCase()
    .replace(/[_./]+/g, " ")
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter(Boolean)
    .forEach((token) => {
      if (token.length < 2 || token.length > 32) {
        return;
      }
      if (SKILL_NAME_STOP_WORDS.has(token)) {
        return;
      }
      if (seen.has(token)) {
        return;
      }
      seen.add(token);
      tokens.push(token);
    });
  return tokens;
}

function resolveRequestedSkillName(spark: Record<string, unknown>) {
  const candidate = asSparkText(
    spark,
    ["skill_name", "skillName", "preferred_skill_name", "preferredSkillName"],
    ""
  );
  return candidate
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildAutoSkillName(desiredOutcome: string, problem: string) {
  const prioritizedTokens = [
    ...tokenizeSkillName(desiredOutcome),
    ...tokenizeSkillName(problem),
  ];
  const deduped = Array.from(new Set(prioritizedTokens));
  if (deduped.length === 0) {
    return "Custom Skill";
  }
  return toTitleCase(deduped.slice(0, MAX_AUTO_SKILL_NAME_TOKENS).join(" "));
}

function buildAutoSkillIdBase(
  requestedSkillName: string,
  desiredOutcome: string,
  problem: string
) {
  const preferredSlug = toSlug(requestedSkillName);
  if (preferredSlug) {
    return enforceSkillIdConstraints(preferredSlug);
  }

  const prioritizedTokens = [
    ...tokenizeSkillName(desiredOutcome),
    ...tokenizeSkillName(problem),
  ];
  const deduped = Array.from(new Set(prioritizedTokens));
  const joined = deduped.slice(0, MAX_AUTO_SKILL_ID_TOKENS).join("-");
  if (joined) {
    return enforceSkillIdConstraints(joined);
  }
  return enforceSkillIdConstraints("custom-skill");
}

function normalizeInputKey(value: string, index: number) {
  const trimmed = value.trim().toLowerCase();
  const candidate = trimmed
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!candidate) {
    return `input_${index}`;
  }
  if (!/^[a-z]/.test(candidate)) {
    return `input_${index}_${candidate}`.slice(0, 48);
  }
  return candidate.slice(0, 48);
}

function sanitizeInputHintKey(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  let normalized = trimmed
    // Drop trailing "(type / example / optional ...)" hints.
    .replace(/\s*\([^)]*\)\s*$/g, "")
    // Drop trailing "e.g. ..." phrase.
    .replace(/\s*[,-]?\s*e\.?\s*g\.?\s*[:= -].*$/i, "")
    // Keep key-like left side before common separators.
    .replace(/\s*[=-]\s*.*$/g, "")
    .trim();

  // If still contains whitespace, prefer the first token as likely field name.
  if (/\s+/.test(normalized)) {
    normalized = normalized.split(/\s+/g)[0] ?? normalized;
  }
  return normalized.trim();
}

function parseInputExamples(inputs: string[]) {
  const parsed: Record<string, unknown> = {};
  inputs.slice(0, 8).forEach((raw, index) => {
    const separatorIndex = raw.indexOf(":");
    if (separatorIndex > 0) {
      const left = sanitizeInputHintKey(raw.slice(0, separatorIndex));
      const right = raw.slice(separatorIndex + 1).trim();
      const key = normalizeInputKey(left, index + 1);
      parsed[key] = right || "example";
      return;
    }
    const key = normalizeInputKey(sanitizeInputHintKey(raw), index + 1);
    parsed[key] = "example";
  });

  if (Object.keys(parsed).length === 0) {
    parsed.sample_input = "example";
  }

  return parsed;
}

function buildInputSchema(exampleInput: Record<string, unknown>) {
  const properties: Record<string, unknown> = {};
  Object.keys(exampleInput).forEach((key) => {
    properties[key] = {
      type: "string",
      description: `Input field '${key}' accepted by generated forge skill.`,
    };
  });
  return {
    type: "object",
    properties,
    additionalProperties: true,
  } satisfies Record<string, unknown>;
}

function mergeSchemaRequiredLists(
  generatedRequired: unknown,
  baselineRequired: unknown
) {
  const source = [
    ...(Array.isArray(generatedRequired) ? generatedRequired : []),
    ...(Array.isArray(baselineRequired) ? baselineRequired : []),
  ];
  return Array.from(
    new Set(
      source
        .map((entry) => asNonEmptyText(entry))
        .filter(Boolean)
    )
  );
}

function mergeInputSchemas(params: {
  generated: Record<string, unknown>;
  baseline?: Record<string, unknown> | null;
}) {
  const baseline = params.baseline ? asRecord(params.baseline) : {};
  if (Object.keys(baseline).length === 0) {
    return params.generated;
  }

  const generatedProperties = asRecord(params.generated.properties);
  const baselineProperties = asRecord(baseline.properties);
  const required = mergeSchemaRequiredLists(
    params.generated.required,
    baseline.required
  );
  const additionalProperties =
    params.generated.additionalProperties ??
    baseline.additionalProperties ??
    true;

  const merged: Record<string, unknown> = {
    ...baseline,
    ...params.generated,
    type: "object",
    properties: {
      ...baselineProperties,
      ...generatedProperties,
    },
    additionalProperties,
  };
  if (required.length > 0) {
    merged.required = required;
  }
  return merged;
}

function buildOutputSchema() {
  return {
    type: "object",
    properties: {
      status: { type: "string" },
      summary: { type: "string" },
    },
    required: ["status"],
    additionalProperties: true,
  } satisfies Record<string, unknown>;
}

function buildFallbackTestCases(params: {
  exampleInput: Record<string, unknown>;
  requireStructuredSuccess: boolean;
}): SSEFForgeTestCase[] {
  const structuredAssertions: SSEFForgeTestCaseAssertion[] = [
    { kind: "path_exists", path: "status" },
    { kind: "path_exists", path: "summary" },
  ];
  if (params.requireStructuredSuccess) {
    structuredAssertions.push({ kind: "equals", path: "status", value: "ok" });
  }

  return [
    {
      id: "smoke_output_envelope",
      description: "Skill returns JSON with status and summary fields.",
      input: {},
      assertions: [
        { kind: "path_exists", path: "status" },
        { kind: "path_exists", path: "summary" },
      ],
    },
    {
      id: "structured_input_envelope",
      description:
        "Skill handles representative structured input and still returns envelope.",
      input: params.exampleInput,
      assertions: structuredAssertions,
    },
    {
      id: "empty_input_stability",
      description: "Skill remains stable with empty args input.",
      input: {},
      assertions: [{ kind: "path_exists", path: "status" }],
    },
  ];
}

function buildUpgradeCompatibilityTestCases(
  baselineManifest: SkillManifestV1 | null
): SSEFForgeTestCase[] {
  if (!baselineManifest) {
    return [];
  }
  const inputSchema = asRecord(baselineManifest.inputs_schema);
  const keys = extractInputSchemaKeys(inputSchema);
  if (keys.length === 0) {
    return [];
  }
  const compatibilityInput = buildUpgradeCompatibilityInput(inputSchema);
  if (Object.keys(compatibilityInput).length === 0) {
    return [];
  }

  return [
    {
      id: "upgrade_backward_compat_input",
      description:
        "Upgrade keeps baseline input contract operational for existing callers.",
      input: compatibilityInput,
      assertions: [{ kind: "path_exists", path: "status" }],
    },
  ];
}

function extractMessageText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return "";
  }
  const chunks: string[] = [];
  value.forEach((part) => {
    if (typeof part === "string") {
      chunks.push(part);
      return;
    }
    if (!isRecord(part)) {
      return;
    }
    const text = asNonEmptyText(part.text ?? part.content ?? part.value);
    if (text) {
      chunks.push(text);
    }
  });
  return chunks.join("\n").trim();
}

function parseJsonObjectFromText(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const directStart = trimmed.indexOf("{");
  const directEnd = trimmed.lastIndexOf("}");
  if (directStart !== -1 && directEnd !== -1 && directEnd > directStart) {
    try {
      const parsed = JSON.parse(trimmed.slice(directStart, directEnd + 1));
      return isRecord(parsed) ? parsed : null;
    } catch {
      // Try fenced fallback below.
    }
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (!fencedMatch || fencedMatch.length < 2) {
    return null;
  }
  try {
    const parsed = JSON.parse(fencedMatch[1]);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stripCodeFences(value: string) {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:javascript|js)?\s*([\s\S]*?)```$/i);
  if (!fenced || fenced.length < 2) {
    return trimmed;
  }
  return fenced[1].trim();
}

function normalizeEntrypointFileName(value: unknown) {
  const raw = asNonEmptyText(value) || "entrypoint.js";
  const withoutLeadingSlash = raw.replace(/\\/g, "/").replace(/^\/+/, "");
  const normalized = path.posix.normalize(withoutLeadingSlash);
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    return "entrypoint.js";
  }
  return normalized.endsWith(".js") ? normalized : `${normalized}.js`;
}

function normalizeTestCaseId(value: unknown, index: number) {
  const text = asNonEmptyText(value);
  if (!text) {
    return `case_${String(index + 1)}`;
  }
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug.length > 0 ? slug.slice(0, 64) : `case_${String(index + 1)}`;
}

function normalizeAssertion(
  raw: unknown
): SSEFForgeTestCaseAssertion | null {
  if (!isRecord(raw)) {
    return null;
  }
  const kind = asNonEmptyText(raw.kind).toLowerCase();
  const pathValue = asNonEmptyText(raw.path);
  if (!pathValue) {
    return null;
  }
  if (kind === "path_exists") {
    return { kind: "path_exists", path: pathValue };
  }
  if (kind === "equals") {
    const value = raw.value;
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      return {
        kind: "equals",
        path: pathValue,
        value,
      };
    }
    return null;
  }
  if (kind === "contains") {
    const value = asNonEmptyText(raw.value);
    if (!value) {
      return null;
    }
    return {
      kind: "contains",
      path: pathValue,
      value,
    };
  }
  if (kind === "array_includes") {
    const value = raw.value;
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      return {
        kind: "array_includes",
        path: pathValue,
        value,
      };
    }
    return null;
  }
  return null;
}

function normalizeTestCases(value: unknown): SSEFForgeTestCase[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seenIds = new Set<string>();
  const normalized: SSEFForgeTestCase[] = [];

  value.slice(0, MAX_GENERATED_TEST_CASES).forEach((rawCase, index) => {
    if (!isRecord(rawCase)) {
      return;
    }
    const id = normalizeTestCaseId(rawCase.id, index);
    if (seenIds.has(id)) {
      return;
    }
    const description =
      asNonEmptyText(rawCase.description) ||
      `Generated test case ${String(index + 1)}.`;
    const input = isRecord(rawCase.input) ? rawCase.input : {};
    const rawAssertions = Array.isArray(rawCase.assertions)
      ? rawCase.assertions
      : [];
    const assertions = rawAssertions
      .map((entry) => normalizeAssertion(entry))
      .filter((entry): entry is SSEFForgeTestCaseAssertion => Boolean(entry));
    if (assertions.length === 0) {
      return;
    }

    seenIds.add(id);
    normalized.push({
      id,
      description: clipText(description, 240),
      input,
      assertions,
    });
  });

  return normalized;
}

function coerceReasoningEffort(value: unknown, fallback: SSEFForgeReasoningEffort) {
  const normalized = asNonEmptyText(value).toLowerCase();
  if (
    normalized &&
    SSEF_FORGE_REASONING_EFFORTS.includes(normalized as SSEFForgeReasoningEffort)
  ) {
    return normalized as SSEFForgeReasoningEffort;
  }
  return fallback;
}

function resolveGenerationOptions(
  options: Partial<SSEFForgeGenerationOptions> | null | undefined
): SSEFForgeGenerationOptions {
  const config = getSSEFConfig();
  const modelCatalog = config.forgeGeneration.modelCatalog;
  const requestedModel = asNonEmptyText(options?.model);
  const model = requestedModel || config.forgeGeneration.defaultModel;
  if (!modelCatalog.includes(model)) {
    throw new Error(
      `Forge model '${model}' is not allowed. Allowed models: ${modelCatalog.join(", ")}.`
    );
  }

  return {
    model,
    reasoningEffort: coerceReasoningEffort(
      options?.reasoningEffort,
      config.forgeGeneration.defaultReasoningEffort
    ),
  };
}

function hasProcessPermissionForCommand(
  manifest: SkillManifestV1,
  command: string
) {
  return manifest.permissions.some((permission) => {
    if (permission.kind !== "process") {
      return false;
    }
    return permission.commands.some(
      (allowed) => allowed === command || allowed === "*"
    );
  });
}

function ensureRequiredProcessPermissions(
  manifest: SkillManifestV1
): SkillManifestV1 {
  const requiredCommands = new Set<string>(["node"]);
  if ((manifest.runtime_dependencies?.pip?.length ?? 0) > 0) {
    requiredCommands.add("python3");
    requiredCommands.add("python");
  }

  const missingCommands = Array.from(requiredCommands).filter(
    (command) => !hasProcessPermissionForCommand(manifest, command)
  );
  if (missingCommands.length === 0) {
    return manifest;
  }

  const withNodePermission = {
    ...manifest,
    permissions: [
      ...manifest.permissions,
      {
        kind: "process" as const,
        scope: "spawn" as const,
        commands: missingCommands,
        max_runtime_ms: 20_000,
        max_memory_mb: 512,
        max_cpu_seconds: 60,
      },
    ],
  };
  return validateSkillManifestV1(withNodePermission);
}

function buildManifestFromModel(params: {
  modelManifest: unknown;
  skillId: string;
  version: string;
  entrypointFileName: string;
  skillName: string;
  desiredOutcome: string;
  exampleInput: Record<string, unknown>;
  testCasesFileName: string;
  baselineManifest?: SkillManifestV1 | null;
}): SkillManifestV1 {
  const baselineManifest = params.baselineManifest ?? null;
  const defaultManifest: Record<string, unknown> = {
    manifest_version: 1,
    id: params.skillId,
    version: params.version,
    name: clipText(params.skillName, 120),
    description: clipText(
      baselineManifest?.description ||
        `Auto-forged SSEF skill for: ${params.desiredOutcome}`,
      500
    ),
    runtime: "node",
    entrypoint: params.entrypointFileName,
    permissions:
      baselineManifest?.permissions && baselineManifest.permissions.length > 0
        ? baselineManifest.permissions
        : [
            {
              kind: "process",
              scope: "spawn",
              commands: ["node"],
              max_runtime_ms: 20_000,
              max_memory_mb: 512,
              max_cpu_seconds: 60,
            },
          ],
    requires_context: baselineManifest?.requires_context === true,
    context_keys:
      baselineManifest?.requires_context === true
        ? baselineManifest.context_keys
        : [],
    inputs_schema: mergeInputSchemas({
      generated: buildInputSchema(params.exampleInput),
      baseline: baselineManifest
        ? asRecord(baselineManifest.inputs_schema)
        : undefined,
    }),
    outputs_schema: baselineManifest
      ? asRecord(baselineManifest.outputs_schema)
      : buildOutputSchema(),
    test_cases: [params.testCasesFileName],
    runtime_dependencies: baselineManifest?.runtime_dependencies,
  };

  const modelManifest = asRecord(params.modelManifest);
  const mergedManifest: Record<string, unknown> = {
    ...defaultManifest,
    ...modelManifest,
    manifest_version: 1,
    id: params.skillId,
    version: params.version,
    runtime: "node",
    entrypoint: params.entrypointFileName,
    test_cases: [params.testCasesFileName],
  };

  if (mergedManifest.requires_context !== true) {
    mergedManifest.requires_context = false;
    mergedManifest.context_keys = [];
  } else if (
    !Array.isArray(mergedManifest.context_keys) ||
    mergedManifest.context_keys.length === 0
  ) {
    mergedManifest.requires_context = false;
    mergedManifest.context_keys = [];
  }

  let manifest: SkillManifestV1;
  try {
    manifest = validateSkillManifestV1(mergedManifest);
  } catch {
    const fallbackManifest = {
      ...mergedManifest,
      permissions: defaultManifest.permissions,
      requires_context: false,
      context_keys: [],
    };
    manifest = validateSkillManifestV1(fallbackManifest);
  }

  return ensureRequiredProcessPermissions(manifest);
}

function mergeTestCases(
  generated: SSEFForgeTestCase[],
  fallback: SSEFForgeTestCase[]
) {
  const seen = new Set<string>();
  const merged: SSEFForgeTestCase[] = [];

  [...generated, ...fallback].forEach((testCase) => {
    if (seen.has(testCase.id)) {
      return;
    }
    seen.add(testCase.id);
    merged.push(testCase);
  });

  return merged.slice(0, MAX_GENERATED_TEST_CASES);
}

function buildModelPrompt(input: {
  proposal: SSEFProposal;
  skillId: string;
  skillName: string;
  requestedSkillName: string;
  version: string;
  promptContractText: string;
  previousFeedback: string[];
  reuseCandidates: SSEFForgeReuseSuggestion[];
  reuseReason: string | null;
  desiredOutcome: string;
  problem: string;
  constraints: string[];
  inputs: string[];
  upgradeTargetSkillId?: string | null;
  upgradeBaseVersion?: string | null;
  upgradeWorkspacePreview?: string | null;
  baselineInputKeys?: string[];
}) {
  const sparkSummary = {
    problem: input.problem,
    desired_outcome: input.desiredOutcome,
    skill_name: input.requestedSkillName || null,
    constraints: input.constraints,
    inputs: input.inputs,
    priority: input.proposal.priority ?? input.proposal.spark.priority ?? DEFAULT_PRIORITY,
    upgrade_target_skill_id: input.upgradeTargetSkillId ?? null,
    upgrade_base_version: input.upgradeBaseVersion ?? null,
  };

  const isUpgrade = Boolean(input.upgradeTargetSkillId);

  return [
    "Generate a production-grade SSEF skill candidate.",
    `Required skill id: ${input.skillId}`,
    `Required human-readable skill name: ${input.skillName}`,
    `Spark preferred skill name: ${input.requestedSkillName || "none provided"}`,
    `Required version: ${input.version}`,
    "Required runtime: node",
    "Entrypoint must be JavaScript and executable with `node <entrypoint>`.",
    "",
    "Spark summary:",
    toJson(sparkSummary),
    "",
    "Raw spark payload:",
    toJson(input.proposal.spark ?? {}),
    "",
    "Prompt contract:",
    input.promptContractText,
    "",
    `Reuse reason: ${input.reuseReason ?? "none"}`,
    `Reuse candidates: ${toJson(input.reuseCandidates)}`,
    "",
    "Previous forge feedback (if any):",
    input.previousFeedback.length > 0
      ? input.previousFeedback.map((entry) => `- ${entry}`).join("\n")
      : "- none",
    "",
    "Upgrade mode:",
    isUpgrade
      ? `- enabled (target=${input.upgradeTargetSkillId}, base_version=${input.upgradeBaseVersion ?? "unknown"})`
      : "- disabled",
    isUpgrade
      ? "- Prefer workspace_edits for surgical changes. Keep baseline behavior unless spark constraints require changes."
      : "- Not applicable.",
    isUpgrade
      ? `- Baseline input keys to keep backward compatible: ${(input.baselineInputKeys ?? []).join(", ") || "(none)"}`
      : "- Not applicable.",
    "",
    "Upgrade workspace baseline:",
    isUpgrade
      ? input.upgradeWorkspacePreview ?? "(upgrade baseline unavailable)"
      : "(none)",
    "",
    "Important:",
    "- Implement real behavior for the requested capability (no placeholder-only stubs).",
    "- Use robust error handling and return structured JSON with `status` and `summary`.",
    "- For external integrations, design a clear adapter boundary driven by args/options (no hardcoded secrets).",
    "- Prefer generic provider-ready code paths so future integrations can be extended cleanly.",
    "- Keep secrets out of code and never hardcode private tokens.",
    "- If external npm/pip packages are used, list them in manifest.runtime_dependencies.",
    "- Include process permissions for every command your entrypoint invokes (for example node, python, python3).",
    "- Build simple, viable tests focused on output contract and core stability.",
    "- Avoid brittle tests that require exact summary wording.",
    "- Avoid tests that require live external network availability.",
    "- Keep manifest.name concise and aligned to the requested capability.",
    "- For upgrade proposals, preserve backward compatibility for baseline input keys.",
    "",
    "Return ONLY the JSON artifact envelope.",
  ].join("\n");
}

async function callForgeGeneratorModel(input: {
  model: string;
  reasoningEffort: SSEFForgeReasoningEffort;
  prompt: string;
}) {
  const response = await createChatCompletion({
    model: input.model,
    messages: [
      {
        role: "system",
        content: FORGE_GENERATOR_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: input.prompt,
      },
    ],
    temperature: DEFAULT_FORGE_MODEL_TEMPERATURE,
    stream: false,
    reasoning:
      input.reasoningEffort === "none"
        ? undefined
        : {
            effort: input.reasoningEffort,
          },
  });

  if (!response.ok) {
    const errorText = clipText(await response.text(), 800);
    throw new Error(
      `Forge model generation request failed (${response.status}): ${errorText}`
    );
  }

  const payload = (await response.json()) as ForgeModelResponseEnvelope;
  const content = extractMessageText(payload.choices?.[0]?.message?.content);
  if (!content) {
    throw new Error("Forge model returned empty content.");
  }

  const parsed = parseJsonObjectFromText(content);
  if (!parsed) {
    throw new Error("Forge model output is not valid JSON.");
  }

  return {
    parsed,
    rawContent: content,
  };
}

function resolveEntrypointCode(payload: Record<string, unknown>) {
  const direct = asNonEmptyText(payload.entrypoint_code);
  if (direct) {
    return stripCodeFences(direct);
  }
  const alternate = asNonEmptyText(payload.code);
  if (alternate) {
    return stripCodeFences(alternate);
  }
  const entrypoint = payload.entrypoint;
  if (typeof entrypoint === "string") {
    return stripCodeFences(entrypoint);
  }
  if (isRecord(entrypoint)) {
    const embedded = asNonEmptyText(
      entrypoint.code ?? entrypoint.content ?? entrypoint.source
    );
    if (embedded) {
      return stripCodeFences(embedded);
    }
  }
  return "";
}

export async function generateSSEFForgeArtifacts(
  input: GenerateSSEFForgeArtifactsInput
): Promise<SSEFForgeGeneratedArtifacts> {
  const spark = input.proposal.spark ?? {};
  const problem = clipText(
    asSparkText(
      spark,
      ["problem", "need", "issue"],
      "Unspecified capability gap."
    ),
    500
  );
  const desiredOutcome = clipText(
    asSparkText(
      spark,
      ["desired_outcome", "desiredOutcome", "outcome", "goal"],
      "Deliver the requested capability."
    ),
    500
  );
  const constraints = asSparkList(spark, [
    "constraints",
    "constraint",
    "guardrails",
  ]);
  const inputs = asSparkList(spark, ["inputs", "input", "input_examples"]);
  const priority = normalizePriority(spark);
  const requestedSkillName = resolveRequestedSkillName(spark);
  const upgradeTarget = readSSEFProposalUpgradeTarget(input.proposal);

  let skillId: string;
  let version: string;
  let upgradeBaseVersion: string | null = null;
  let existingSkillName: string | null = null;

  if (upgradeTarget) {
    const existingSkill = await getSSEFSkillBySkillId(upgradeTarget.targetSkillId);
    if (!existingSkill) {
      throw new Error(
        `Upgrade target skill '${upgradeTarget.targetSkillId}' was not found.`
      );
    }
    skillId = existingSkill.skillId;
    existingSkillName = existingSkill.name ?? null;
    upgradeBaseVersion = existingSkill.latestVersion ?? existingSkill.activeVersion;
    version = await resolveUpgradeVersion({
      skillId,
      bump: upgradeTarget.versionBump,
      baseVersion: upgradeBaseVersion,
    });
  } else {
    const baseSkillId = buildAutoSkillIdBase(
      requestedSkillName,
      desiredOutcome,
      problem
    );
    skillId = await resolveUniqueSkillId(baseSkillId, input.proposal.id);
    version = DEFAULT_INITIAL_VERSION;
  }

  const resolvedSkillName =
    requestedSkillName ||
    existingSkillName ||
    buildAutoSkillName(desiredOutcome, problem);
  let upgradeBaseline: SSEFUpgradeBaselineArtifacts | null = null;
  if (upgradeTarget) {
    if (!upgradeBaseVersion) {
      throw new Error(
        `Upgrade target skill '${skillId}' has no baseline version to upgrade from.`
      );
    }
    upgradeBaseline = await readUpgradeBaselineArtifacts({
      skillId,
      version: upgradeBaseVersion,
    });
  }

  const defaultEntrypointFileName =
    upgradeBaseline?.entrypointFileName ?? "entrypoint.js";
  const testCasesFileName = upgradeBaseline?.testCasesFileName ?? "test_cases.json";
  const baselineInputKeys = upgradeBaseline
    ? extractInputSchemaKeys(asRecord(upgradeBaseline.manifest.inputs_schema))
    : [];
  const upgradeWorkspacePreview = upgradeBaseline
    ? buildUpgradeWorkspacePreview({
        entrypointFileName: upgradeBaseline.entrypointFileName,
        entrypointContent: upgradeBaseline.entrypointContent,
        manifest: upgradeBaseline.manifest,
        testCasesFileName: upgradeBaseline.testCasesFileName,
        testCases: upgradeBaseline.testCases,
      })
    : null;

  const exampleInput = parseInputExamples(inputs);
  const fallbackTests = buildFallbackTestCases({
    exampleInput,
    requireStructuredSuccess: inputs.length > 0 || baselineInputKeys.length > 0,
  });
  const upgradeCompatibilityTests = buildUpgradeCompatibilityTestCases(
    upgradeBaseline?.manifest ?? null
  );

  const generationOptions = resolveGenerationOptions(input.generationOptions);
  const promptContractText = buildSSEFForgePromptContract({
    proposal: input.proposal,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    previousFailureSummary: [
      ...(input.previousFeedback?.reasons ?? []),
      ...(input.previousFeedback?.sandboxDiagnostics ?? []),
      ...(input.previousFeedback?.criticFindings ?? []),
    ].slice(0, 24),
  });
  const prompt = buildModelPrompt({
    proposal: input.proposal,
    skillId,
    skillName: resolvedSkillName,
    requestedSkillName,
    version,
    promptContractText,
    previousFeedback: [
      ...(input.previousFeedback?.reasons ?? []),
      ...(input.previousFeedback?.sandboxDiagnostics ?? []),
      ...(input.previousFeedback?.criticFindings ?? []),
    ].slice(0, 32),
    reuseCandidates: input.reuseCandidates ?? [],
    reuseReason: input.reuseReason ?? null,
    desiredOutcome,
    problem,
    constraints,
    inputs,
    upgradeTargetSkillId: upgradeTarget?.targetSkillId ?? null,
    upgradeBaseVersion,
    upgradeWorkspacePreview,
    baselineInputKeys,
  });
  const modelOutput = await callForgeGeneratorModel({
    model: generationOptions.model,
    reasoningEffort: generationOptions.reasoningEffort,
    prompt,
  });

  const workspaceEdits = normalizeWorkspaceEdits(
    modelOutput.parsed.workspace_edits ?? modelOutput.parsed.edits
  );
  let workspaceFiles: Map<string, string> | null = null;
  if (upgradeBaseline) {
    workspaceFiles = new Map<string, string>([
      ["manifest.json", `${JSON.stringify(upgradeBaseline.manifest, null, 2)}\n`],
      [upgradeBaseline.entrypointFileName, upgradeBaseline.entrypointContent],
      [
        upgradeBaseline.testCasesFileName,
        `${JSON.stringify(upgradeBaseline.testCases, null, 2)}\n`,
      ],
    ]);
  }
  if (workspaceFiles && workspaceEdits.length > 0) {
    workspaceFiles = applyWorkspaceEdits({
      files: workspaceFiles,
      operations: workspaceEdits,
    });
  }

  const modelEntrypointFileName = normalizeEntrypointFileName(
    modelOutput.parsed.entrypoint_file ?? asRecord(modelOutput.parsed.manifest).entrypoint
  );
  const resolvedEntrypointFileName =
    modelEntrypointFileName || defaultEntrypointFileName;
  let entrypointContent =
    workspaceFiles?.get(resolvedEntrypointFileName)?.trim().length
      ? stripCodeFences(workspaceFiles.get(resolvedEntrypointFileName) ?? "")
      : "";
  if (!entrypointContent) {
    entrypointContent = resolveEntrypointCode(modelOutput.parsed);
  }
  if (!entrypointContent && upgradeBaseline) {
    entrypointContent = upgradeBaseline.entrypointContent;
  }
  if (!entrypointContent || entrypointContent.trim().length === 0) {
    throw new Error("Forge model output did not include entrypoint code.");
  }
  if (entrypointContent.length > MAX_ENTRYPOINT_CHARS) {
    throw new Error(
      `Forge model entrypoint code exceeds max size (${MAX_ENTRYPOINT_CHARS} chars).`
    );
  }

  const workspaceManifest = workspaceFiles?.get("manifest.json")
    ? parseJsonRecordFromText(
        workspaceFiles.get("manifest.json") ?? "{}",
        "workspace manifest.json"
      )
    : {};
  const modelManifest = asRecord(modelOutput.parsed.manifest);
  const manifestSource = {
    ...workspaceManifest,
    ...modelManifest,
  };

  const manifest = buildManifestFromModel({
    modelManifest: manifestSource,
    skillId,
    version,
    skillName: resolvedSkillName,
    entrypointFileName: resolvedEntrypointFileName,
    desiredOutcome,
    exampleInput,
    testCasesFileName,
    baselineManifest: upgradeBaseline?.manifest ?? null,
  });
  const generatedTests = normalizeTestCases(
    modelOutput.parsed.test_cases ?? modelOutput.parsed.tests
  );
  const workspaceTests = workspaceFiles?.get(testCasesFileName)
    ? normalizeTestCases(
        JSON.parse(workspaceFiles.get(testCasesFileName) ?? "[]")
      )
    : [];
  const testCases = mergeTestCases(
    mergeTestCases(generatedTests, workspaceTests),
    [...upgradeCompatibilityTests, ...fallbackTests]
  );
  const uniqueReuseCandidates = Array.from(
    new Set((input.reuseCandidates ?? []).map((candidate) => candidate.skillId))
  ).slice(0, 4);

  return {
    skillId,
    version,
    runtime: "node",
    promptContractVersion: SSEF_FORGE_PROMPT_CONTRACT_VERSION,
    promptContractText,
    manifest,
    entrypointFileName: resolvedEntrypointFileName,
    entrypointContent,
    testCasesFileName,
    testCases,
    metadata: {
      generation_strategy: upgradeTarget
        ? "llm_workspace_upgrade_v1"
        : "llm_contract_v2",
      proposal_id: input.proposal.id,
      attempt: input.attempt,
      max_attempts: input.maxAttempts,
      model: generationOptions.model,
      reasoning_effort: generationOptions.reasoningEffort,
      priority,
      requested_skill_name: requestedSkillName || null,
      resolved_skill_name: resolvedSkillName,
      upgrade_target_skill_id: upgradeTarget?.targetSkillId ?? null,
      upgrade_version_bump: upgradeTarget?.versionBump ?? null,
      upgrade_base_version: upgradeBaseVersion,
      upgrade_workspace_edits_applied: workspaceEdits.length,
      baseline_input_keys: baselineInputKeys,
      constraint_count: constraints.length,
      input_hint_count: inputs.length,
      reuse_reason: input.reuseReason ?? null,
      reuse_candidate_count: uniqueReuseCandidates.length,
      reuse_candidates: (input.reuseCandidates ?? []).map((candidate) => ({
        skill_id: candidate.skillId,
        score: candidate.score,
      })),
      previous_feedback_count:
        (input.previousFeedback?.reasons.length ?? 0) +
        (input.previousFeedback?.sandboxDiagnostics.length ?? 0) +
        (input.previousFeedback?.criticFindings.length ?? 0),
      generated_test_case_count: generatedTests.length,
      workspace_test_case_count: workspaceTests.length,
      upgrade_compatibility_test_case_count: upgradeCompatibilityTests.length,
      final_test_case_count: testCases.length,
      test_selection_strategy: upgradeTarget
        ? "generated_plus_upgrade_compat_v1"
        : "fallback_baseline_v1",
      model_response_preview: clipText(
        modelOutput.rawContent,
        MAX_MODEL_RESPONSE_PREVIEW_CHARS
      ),
    },
  };
}
