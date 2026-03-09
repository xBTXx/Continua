import { ensureSchema, query } from "@/lib/db";
import type { ToolDefinition } from "@/lib/openrouter";
import { ensureSSEFReady } from "../bootstrap";
import { getSSEFConfig, ssefEnabled } from "../config";
import type { SkillManifestV1 } from "../contracts/manifest";
import { validateSkillManifestV1 } from "../contracts/manifest";

type ActiveSkillRuntimeRow = {
  skill_db_id: string;
  skill_id: string;
  name: string | null;
  description: string;
  lifecycle_state: string;
  active_version: string | null;
  skill_version_id: string;
  runtime: string;
  entrypoint: string;
  manifest: unknown;
  updated_at: string;
};

export type SSEFActiveSkillRuntimeRecord = {
  skillDbId: string;
  skillVersionId: string;
  skillId: string;
  name: string;
  description: string;
  lifecycleState: string;
  version: string;
  runtime: SkillManifestV1["runtime"];
  entrypoint: string;
  manifest: SkillManifestV1;
  updatedAt: string;
};

export type ActiveSkillToolDefinitionSelection = {
  queryText?: string | null;
  maxTools?: number | null;
  minScore?: number | null;
  maxQueryTokens?: number | null;
};

export type ActiveSSEFSkillCatalogEntry = {
  name: string;
  description: string;
};

export type ActiveSkillToolDefinitionsBundle = {
  selectedTools: ToolDefinition[];
  activeCatalogEntries: ActiveSSEFSkillCatalogEntry[];
};

const DEFAULT_SELECTION_MAX_TOOLS = 8;
const DEFAULT_SELECTION_MIN_SCORE = 0.14;
const DEFAULT_SELECTION_MAX_QUERY_TOKENS = 24;
const SELECTION_STOP_WORDS = new Set<string>([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "get",
  "has",
  "have",
  "i",
  "in",
  "is",
  "it",
  "me",
  "of",
  "on",
  "or",
  "please",
  "that",
  "the",
  "to",
  "tool",
  "tools",
  "use",
  "using",
  "want",
  "with",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function asText(value: string | null | undefined) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeSearchText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function toSafeMaxTools(value: number | null | undefined) {
  const parsed = Number(value ?? DEFAULT_SELECTION_MAX_TOOLS);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_SELECTION_MAX_TOOLS;
  }
  return Math.min(64, Math.max(1, Math.floor(parsed)));
}

function toSafeMinScore(value: number | null | undefined) {
  const parsed = Number(value ?? DEFAULT_SELECTION_MIN_SCORE);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_SELECTION_MIN_SCORE;
  }
  return Math.min(1, Math.max(0, parsed));
}

function toSafeMaxQueryTokens(value: number | null | undefined) {
  const parsed = Number(value ?? DEFAULT_SELECTION_MAX_QUERY_TOKENS);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_SELECTION_MAX_QUERY_TOKENS;
  }
  return Math.min(200, Math.max(4, Math.floor(parsed)));
}

function tokenizeSelectionQuery(
  query: string,
  maxTokens: number
): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  const rawTokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter(Boolean);

  for (const token of rawTokens) {
    if (token.length < 3 || SELECTION_STOP_WORDS.has(token)) {
      continue;
    }
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    tokens.push(token);
    if (tokens.length >= maxTokens) {
      break;
    }
  }

  return tokens;
}

function getInputSchemaPropertyKeys(
  inputsSchema: Record<string, unknown>
): string[] {
  const properties = inputsSchema.properties;
  if (!isRecord(properties)) {
    return [];
  }
  return Object.keys(properties)
    .map((key) => key.trim())
    .filter(Boolean)
    .slice(0, 32);
}

function buildRecordSearchParts(record: SSEFActiveSkillRuntimeRecord) {
  const propertyKeys = getInputSchemaPropertyKeys(record.manifest.inputs_schema);
  return [
    normalizeSearchText(record.skillId),
    normalizeSearchText(record.name),
    normalizeSearchText(record.description),
    normalizeSearchText(asText(record.manifest.description)),
    ...propertyKeys.map((key) => normalizeSearchText(key)),
  ].filter(Boolean);
}

function scoreRecordAgainstTokens(
  record: SSEFActiveSkillRuntimeRecord,
  tokens: string[],
  normalizedQuery: string
) {
  const parts = buildRecordSearchParts(record);
  if (parts.length === 0 || tokens.length === 0) {
    return 0;
  }

  let matchedTokens = 0;
  let tokenScore = 0;

  for (const token of tokens) {
    let bestMatch = 0;
    parts.forEach((part, index) => {
      if (!part) {
        return;
      }
      if (part === token) {
        bestMatch = Math.max(bestMatch, index === 0 ? 1 : 0.9);
        return;
      }
      if (part.startsWith(`${token} `) || part.includes(` ${token} `)) {
        bestMatch = Math.max(bestMatch, index === 0 ? 0.85 : 0.68);
        return;
      }
      if (part.includes(token)) {
        bestMatch = Math.max(bestMatch, index === 0 ? 0.72 : 0.52);
      }
    });
    if (bestMatch > 0) {
      matchedTokens += 1;
      tokenScore += bestMatch;
    }
  }

  const coverage = matchedTokens / tokens.length;
  const averageMatch = tokenScore / tokens.length;
  const queryPhraseBoost =
    normalizedQuery.length >= 8 && parts.some((part) => part.includes(normalizedQuery))
      ? 0.1
      : 0;

  return Math.min(1, averageMatch * 0.7 + coverage * 0.3 + queryPhraseBoost);
}

function selectActiveSkillRuntimeRecords(
  records: SSEFActiveSkillRuntimeRecord[],
  selection: ActiveSkillToolDefinitionSelection
) {
  const maxTools = toSafeMaxTools(selection.maxTools);
  if (records.length <= maxTools) {
    return records;
  }

  const normalizedQuery = normalizeSearchText(selection.queryText ?? "");
  const tokens = tokenizeSelectionQuery(
    normalizedQuery,
    toSafeMaxQueryTokens(selection.maxQueryTokens)
  );
  if (tokens.length === 0) {
    return records.slice(0, maxTools);
  }

  const minScore = toSafeMinScore(selection.minScore);
  const scored = records
    .map((record, index) => ({
      record,
      index,
      score: scoreRecordAgainstTokens(record, tokens, normalizedQuery),
    }))
    .filter((entry) => entry.score >= minScore)
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.index - b.index;
    });

  if (scored.length === 0) {
    return records.slice(0, maxTools);
  }

  const selected = scored.slice(0, maxTools).map((entry) => entry.record);
  if (selected.length >= maxTools) {
    return selected;
  }

  const selectedSkillIds = new Set(selected.map((record) => record.skillId));
  for (const record of records) {
    if (selectedSkillIds.has(record.skillId)) {
      continue;
    }
    selected.push(record);
    selectedSkillIds.add(record.skillId);
    if (selected.length >= maxTools) {
      break;
    }
  }

  return selected;
}

function resolveSelectionDefaults(
  selection: ActiveSkillToolDefinitionSelection
): ActiveSkillToolDefinitionSelection {
  const resolved: ActiveSkillToolDefinitionSelection = {
    queryText: selection.queryText ?? "",
    maxTools: selection.maxTools,
    minScore: selection.minScore,
    maxQueryTokens: selection.maxQueryTokens,
  };

  try {
    const config = getSSEFConfig();
    if (resolved.maxTools === null || typeof resolved.maxTools === "undefined") {
      resolved.maxTools = config.runtimeSelection.chatMaxTools;
    }
    if (resolved.minScore === null || typeof resolved.minScore === "undefined") {
      resolved.minScore = config.runtimeSelection.minScore;
    }
    if (
      resolved.maxQueryTokens === null ||
      typeof resolved.maxQueryTokens === "undefined"
    ) {
      resolved.maxQueryTokens = config.runtimeSelection.maxQueryTokens;
    }
  } catch {
    // Fallback to local defaults if config cannot be resolved.
  }

  return resolved;
}

function normalizeToolParametersSchema(
  inputsSchema: Record<string, unknown>
): Record<string, unknown> {
  const hasObjectProperties =
    Object.prototype.hasOwnProperty.call(inputsSchema, "properties") ||
    Object.prototype.hasOwnProperty.call(inputsSchema, "required") ||
    Object.prototype.hasOwnProperty.call(inputsSchema, "additionalProperties");

  if (inputsSchema.type === "object" || hasObjectProperties) {
    return {
      ...inputsSchema,
      type: "object",
    };
  }

  return {
    type: "object",
    properties: {},
    additionalProperties: true,
  };
}

function buildToolDescription(record: SSEFActiveSkillRuntimeRecord) {
  const base = asText(record.manifest.description) || record.description || record.skillId;
  const normalizedBase = base.endsWith(".") ? base : `${base}.`;
  const contextLine = record.manifest.requires_context
    ? "Requires runtime context supplied by the assistant."
    : "";
  return [
    normalizedBase,
    `SSEF skill version ${record.version}.`,
    contextLine,
  ]
    .filter(Boolean)
    .join(" ");
}

function mapRecordToToolDefinition(record: SSEFActiveSkillRuntimeRecord): ToolDefinition {
  return {
    type: "function",
    function: {
      name: record.skillId,
      description: buildToolDescription(record),
      parameters: normalizeToolParametersSchema(record.manifest.inputs_schema),
    },
  };
}

function mapActiveSkillRuntimeRow(
  row: ActiveSkillRuntimeRow
): SSEFActiveSkillRuntimeRecord {
  const manifest = validateSkillManifestV1(asRecord(row.manifest));
  if (manifest.id !== row.skill_id) {
    throw new Error(
      `Manifest id '${manifest.id}' does not match skill_id '${row.skill_id}'.`
    );
  }
  if (manifest.version !== row.active_version) {
    throw new Error(
      `Manifest version '${manifest.version}' does not match active_version '${row.active_version}'.`
    );
  }
  const normalizedEntrypoint =
    asText(row.entrypoint) || asText(manifest.entrypoint);
  if (!normalizedEntrypoint) {
    throw new Error(
      `Active skill '${row.skill_id}' is missing a valid entrypoint path.`
    );
  }

  return {
    skillDbId: row.skill_db_id,
    skillVersionId: row.skill_version_id,
    skillId: row.skill_id,
    name: asText(row.name) || row.skill_id,
    description: row.description,
    lifecycleState: row.lifecycle_state,
    version: manifest.version,
    runtime: manifest.runtime,
    entrypoint: normalizedEntrypoint,
    manifest,
    updatedAt: row.updated_at,
  };
}

function mapRowsWithValidation(rows: ActiveSkillRuntimeRow[]) {
  const items: SSEFActiveSkillRuntimeRecord[] = [];
  rows.forEach((row) => {
    try {
      items.push(mapActiveSkillRuntimeRow(row));
    } catch (error) {
      console.warn("Skipping invalid active SSEF skill record.", {
        skillId: row.skill_id,
        reason: error instanceof Error ? error.message : "unknown",
      });
    }
  });
  return items;
}

async function queryActiveSkillRuntimeRows(
  extraWhereClause: string,
  params: unknown[]
): Promise<ActiveSkillRuntimeRow[]> {
  await ensureSchema();
  const result = await query<ActiveSkillRuntimeRow>(
    `
      SELECT
        s.id AS skill_db_id,
        s.skill_id,
        s.name,
        s.description,
        s.lifecycle_state,
        s.active_version,
        v.id AS skill_version_id,
        v.runtime,
        v.entrypoint,
        v.manifest,
        s.updated_at
      FROM ssef_skills s
      INNER JOIN ssef_skill_versions v
        ON v.skill_id = s.id
       AND s.active_version IS NOT NULL
       AND v.version = s.active_version
      WHERE s.lifecycle_state = 'active'
      ${extraWhereClause}
      ORDER BY s.updated_at DESC, s.skill_id ASC
    `,
    params
  );
  return result.rows;
}

export async function getActiveSSEFSkillRuntimeRecords(): Promise<
  SSEFActiveSkillRuntimeRecord[]
> {
  if (!ssefEnabled()) {
    return [];
  }
  await ensureSSEFReady();
  const rows = await queryActiveSkillRuntimeRows("", []);
  return mapRowsWithValidation(rows);
}

export async function getActiveSSEFSkillRuntimeRecordByToolName(
  toolNameInput: string
): Promise<SSEFActiveSkillRuntimeRecord | null> {
  const toolName = asText(toolNameInput).toLowerCase();
  if (!toolName || !ssefEnabled()) {
    return null;
  }

  await ensureSSEFReady();
  const rows = await queryActiveSkillRuntimeRows("AND s.skill_id = $1", [toolName]);
  const [record] = mapRowsWithValidation(rows);
  return record ?? null;
}

export async function getActiveSkillToolDefinitions(
  selection: ActiveSkillToolDefinitionSelection = {}
): Promise<ToolDefinition[]> {
  const bundle = await getActiveSkillToolDefinitionsBundle(selection);
  return bundle.selectedTools;
}

export async function getActiveSkillToolDefinitionsBundle(
  selection: ActiveSkillToolDefinitionSelection = {}
): Promise<ActiveSkillToolDefinitionsBundle> {
  try {
    const records = await getActiveSSEFSkillRuntimeRecords();
    const selectedRecords = selectActiveSkillRuntimeRecords(
      records,
      resolveSelectionDefaults(selection)
    );
    return {
      selectedTools: selectedRecords.map(mapRecordToToolDefinition),
      activeCatalogEntries: records.map((record) => ({
        name: record.skillId,
        description: buildToolDescription(record),
      })),
    };
  } catch (error) {
    console.warn("Failed to load active SSEF tool definitions.", error);
    return {
      selectedTools: [],
      activeCatalogEntries: [],
    };
  }
}
