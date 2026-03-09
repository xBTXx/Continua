import { randomUUID } from "node:crypto";
import { ensureSchema, query } from "./db";
import { createChatCompletion, type ChatMessage, type ToolDefinition } from "./openrouter";
import { extractTextFromContent } from "./chatContent";
import {
  buildEmailActionContent,
  buildIdleToolInstructions,
  getIdleToolDefinitions,
  LOGGED_EMAIL_TOOLS,
  runIdleTool,
} from "./idleTooling";
import { resolveDomainFromToolCall } from "./webSessions";
import { redactSensitivePayload } from "./webRedaction";
import {
  formatIdleActionLogEntries,
  listIdleActionLogEntries,
  saveIdleActionLogEntries,
  type IdleAction,
} from "./idleActions";
import { listActiveScratchpadNotes, SCRATCHPAD_NOTE_LIMIT } from "./scratchpad";
import { getPersonaProfile } from "./persona";
import { getSystemPrompt } from "./systemPrompt";
import {
  composeSystemPrompt,
  DEFAULT_PERSONA_PROFILE,
  DEFAULT_SYSTEM_PROMPT,
} from "./systemPromptDefaults";
import {
  expandTemporalResonance,
  generateSearchQueries,
  retrieveConversationExcerpts,
  injectMemories,
  injectConversationExcerpts,
  injectPersonalMemories,
  rankResonanceMemories,
  retrieveMemories,
  retrievePersonalMemories,
  type MemorySnippet,
} from "./retrieval";
import { PERSONAL_MEMORY_COLLECTION } from "./personalMemory";

type IdleSeed = {
  id: string;
  source: string;
  content: string;
};

type IdleThought = {
  thought: string;
  tas?: {
    temporal?: string;
    valence?: string;
    self_relevance?: string;
  };
};

type IdleWorkspaceConfig = {
  modelSmart: string;
  modelLite?: string;
  reasoningLevel: "low" | "medium" | "high" | null;
  personaMode: "static" | "dynamic" | "off";
  personaSource: "system_prompt" | "persona_profile" | "mixed";
};

export type IdleWorkspaceResult = {
  sessionId: string;
  finalThought: string;
  summary?: string;
  actions: IdleAction[];
};

export type IdleWorkspaceSession = {
  id: string;
  thoughtText: string;
  seedId: string;
  seedSource: string;
  status: string;
  model?: string | null;
  finalThought?: string | null;
  summary?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type IdleWorkspaceEvent = {
  id: string;
  sessionId: string;
  eventType: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
};

type WorkspaceExitPayload = {
  final_thought?: string;
  summary?: string;
  actions?: IdleAction[];
};

type IdleToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  [key: string]: unknown;
};

const PERSONAL_MEMORY_CATEGORY_ALIASES: Record<string, string> = {
  feeling: "feeling",
  feelings: "feeling",
  emotion: "feeling",
  emotions: "feeling",
  emotional: "feeling",
  experience: "experience",
  experiences: "experience",
  event: "experience",
  thought: "thought",
  thoughts: "thought",
  reflection: "thought",
  reflections: "thought",
  idea: "thought",
  ideas: "thought",
  view: "view",
  views: "view",
  perspective: "view",
  perspectives: "view",
  opinion: "opinion",
  opinions: "opinion",
  belief: "opinion",
  beliefs: "opinion",
};

function parseEnvNumber(
  value: string | undefined,
  fallback: number,
  options?: { min?: number; max?: number }
) {
  if (!value || value.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  let normalized = Math.floor(parsed);
  if (typeof options?.min === "number") {
    normalized = Math.max(options.min, normalized);
  }
  if (typeof options?.max === "number") {
    normalized = Math.min(options.max, normalized);
  }
  return normalized;
}

const MAX_WORKSPACE_STEPS = parseEnvNumber(
  process.env.IDLE_WORKSPACE_MAX_STEPS,
  8,
  { min: 1, max: 60 }
);
const WORKSPACE_WARN_LAST_STEPS = parseEnvNumber(
  process.env.IDLE_WORKSPACE_WARN_LAST_STEPS,
  5,
  { min: 0, max: 60 }
);
const MAX_WORKSPACE_NOTE_LENGTH = 800;
const MAX_EVENT_SUMMARY_LENGTH = 1200;
const MAX_WORKSPACE_TOOL_CONTEXT_LENGTH = parseEnvNumber(
  process.env.IDLE_WORKSPACE_TOOL_CONTEXT_MAX_CHARS,
  8_000,
  { min: 1_000, max: 60_000 }
);
const MAX_MEMORY_CONTEXT_ITEM_LENGTH = 240;
const MEMORY_CONTEXT_LOG_LIMIT = 12;
const WORKSPACE_MEMORY_MAX_TOTAL = parseEnvNumber(
  process.env.IDLE_WORKSPACE_MEMORY_MAX_TOTAL,
  12,
  { min: 1, max: 30 }
);
const WORKSPACE_MEMORY_MAX_MAIN = parseEnvNumber(
  process.env.IDLE_WORKSPACE_MEMORY_MAX_MAIN,
  Math.min(8, WORKSPACE_MEMORY_MAX_TOTAL),
  { min: 0, max: WORKSPACE_MEMORY_MAX_TOTAL }
);
const WORKSPACE_MEMORY_MAX_PERSONAL = parseEnvNumber(
  process.env.IDLE_WORKSPACE_MEMORY_MAX_PERSONAL,
  Math.min(4, WORKSPACE_MEMORY_MAX_TOTAL),
  { min: 0, max: WORKSPACE_MEMORY_MAX_TOTAL }
);
const WORKSPACE_MEMORY_ADD_MAIN = parseEnvNumber(
  process.env.IDLE_WORKSPACE_MEMORY_ADD_MAIN,
  2,
  { min: 0, max: 10 }
);
const WORKSPACE_MEMORY_ADD_PERSONAL = parseEnvNumber(
  process.env.IDLE_WORKSPACE_MEMORY_ADD_PERSONAL,
  2,
  { min: 0, max: 10 }
);
const WORKSPACE_ACTION_SET = new Set([
  "edit_thought",
  "start_conversation",
  "save_note",
]);

const WORKSPACE_EXIT_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "workspace_exit",
    description:
      "Exit the current idle workspace session with a final thought and optional summary/actions.",
    parameters: {
      type: "object",
      properties: {
        final_thought: { type: "string" },
        summary: { type: "string" },
        actions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string" },
              rationale: { type: "string" },
              content: { type: "string" },
              safety_notes: { type: "string" },
              requires_user_confirmation: { type: "boolean" },
            },
          },
        },
      },
      required: ["final_thought"],
    },
  },
};

function resolveMemoryTimestamp(memory: MemorySnippet) {
  return memory.sourceAt ?? memory.createdAt ?? null;
}

function dedupeMemories(memories: MemorySnippet[]) {
  const deduped = new Map<string, MemorySnippet>();
  for (const memory of memories) {
    const memoryId = memory.id?.trim();
    const key = memoryId
      ? `id:${memoryId}`
      : `content:${memory.content.toLowerCase().trim()}`;
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, memory);
      continue;
    }
    const existingTime = resolveMemoryTimestamp(existing);
    const incomingTime = resolveMemoryTimestamp(memory);
    if (!existingTime && incomingTime) {
      deduped.set(key, memory);
    } else if (existingTime && incomingTime && incomingTime > existingTime) {
      deduped.set(key, memory);
    }
  }

  return Array.from(deduped.values()).sort((a, b) => {
    const aTime = resolveMemoryTimestamp(a);
    const bTime = resolveMemoryTimestamp(b);
    if (aTime && bTime) {
      return bTime.localeCompare(aTime);
    }
    if (aTime) {
      return -1;
    }
    if (bTime) {
      return 1;
    }
    return 0;
  });
}

function buildIdleRetrievalMessages(
  thought: IdleThought,
  seed: IdleSeed,
  related: string[],
  stepContext?: string
) {
  const relatedBlock =
    related.length > 0 ? related.map((entry) => `- ${entry}`).join("\n") : "None";
  const contentParts = [
    "Idle workspace context:",
    `Thought: ${thought.thought}`,
    `Seed (${seed.source}): ${seed.content}`,
    "Related idle thoughts:",
    relatedBlock,
  ];
  if (stepContext && stepContext.trim()) {
    contentParts.push("Recent workspace context:", stepContext.trim());
  }
  const userContent = contentParts.join("\n");

  return [
    {
      role: "system",
      content:
        "You are generating memory retrieval queries for an idle workspace session.",
    },
    { role: "user", content: userContent },
  ] satisfies ChatMessage[];
}

function truncateText(text: string, maxLength: number) {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxLength - 3))}...`;
}

function memoryKey(memory: MemorySnippet) {
  const memoryId = memory.id?.trim();
  if (memoryId) {
    return `id:${memoryId}`;
  }
  const content = memory.content?.trim().toLowerCase();
  return content ? `content:${content}` : null;
}

function updateRollingList(
  existing: MemorySnippet[],
  retrieved: MemorySnippet[],
  addLimit: number,
  maxLimit: number
) {
  const list = [...existing];
  let added = 0;

  for (const memory of retrieved) {
    const key = memoryKey(memory);
    if (!key) {
      continue;
    }
    const existingIndex = list.findIndex((entry) => memoryKey(entry) === key);
    if (existingIndex >= 0) {
      const [entry] = list.splice(existingIndex, 1);
      list.push(entry);
      continue;
    }
    if (added >= addLimit) {
      continue;
    }
    list.push(memory);
    added += 1;
  }

  if (maxLimit >= 0 && list.length > maxLimit) {
    list.splice(0, list.length - maxLimit);
  }

  return list;
}

function enforceTotalLimit(
  main: MemorySnippet[],
  personal: MemorySnippet[],
  maxTotal: number
) {
  if (maxTotal <= 0) {
    return { main: [], personal: [] };
  }
  const updatedMain = [...main];
  const updatedPersonal = [...personal];
  while (updatedMain.length + updatedPersonal.length > maxTotal) {
    if (updatedMain.length >= updatedPersonal.length && updatedMain.length > 0) {
      updatedMain.shift();
    } else if (updatedPersonal.length > 0) {
      updatedPersonal.shift();
    } else {
      break;
    }
  }
  return { main: updatedMain, personal: updatedPersonal };
}

function buildStepContext(
  step: number,
  lastAssistantNote: string,
  lastToolSummary: string
) {
  const lines: string[] = [];
  if (lastAssistantNote.trim()) {
    lines.push(`Last assistant note: ${truncateText(lastAssistantNote, 400)}`);
  }
  if (lastToolSummary.trim()) {
    lines.push(`Last tool summary: ${truncateText(lastToolSummary, 400)}`);
  }
  if (lines.length === 0) {
    return "";
  }
  return [`Workspace step ${step + 1}:`, ...lines].join("\n");
}

function buildWorkspaceStatusLines(step: number) {
  const maxSteps = Math.max(1, MAX_WORKSPACE_STEPS);
  const used = Math.min(Math.max(0, step), maxSteps);
  const remaining = Math.max(0, maxSteps - used);
  const lines = [
    `Workspace actions used: ${used}/${maxSteps} (${remaining} remaining).`,
    `Hard limit: ${maxSteps} actions. Auto-exit at the limit.`,
    "Finish before the limit and call workspace_exit yourself.",
  ];
  const warnThreshold = Math.min(
    Math.max(0, WORKSPACE_WARN_LAST_STEPS),
    maxSteps
  );
  if (warnThreshold > 0 && remaining <= warnThreshold) {
    lines.push(
      `Warning: ${remaining} action${remaining === 1 ? "" : "s"} left before forced exit.`
    );
  }
  return lines;
}

function applyWorkspaceMemoryContext(
  messages: ChatMessage[],
  baseSystemPrompt: string,
  memories: MemorySnippet[],
  personalMemories: MemorySnippet[],
  excerpts: Array<{
    conversationId: string;
    memoryContent: string;
    messages: Array<{ id: string; role: string; content: string; createdAt: string }>;
  }>
) {
  const systemIndex = messages.findIndex((message) => message.role === "system");
  if (systemIndex === -1) {
    return messages;
  }
  const updated = [...messages];
  updated[systemIndex] = {
    ...updated[systemIndex],
    content: baseSystemPrompt,
  };
  let next = updated;
  if (memories.length > 0) {
    next = injectMemories(next, memories);
  }
  if (personalMemories.length > 0) {
    next = injectPersonalMemories(next, personalMemories);
  }
  if (excerpts.length > 0) {
    next = injectConversationExcerpts(next, excerpts);
  }
  return next;
}

function summarizeMemoryItems(memories: MemorySnippet[], limit: number) {
  const items = memories.slice(0, limit).map((memory) => ({
    content: truncateText(memory.content, MAX_MEMORY_CONTEXT_ITEM_LENGTH),
    created_at: memory.createdAt ?? null,
    source_at: memory.sourceAt ?? null,
    resonance_primary: memory.resonancePrimary ?? null,
    resonance_weight: memory.resonanceWeight ?? null,
    resonance_intensity:
      typeof memory.resonanceIntensity === "number"
        ? memory.resonanceIntensity
        : null,
    resonance_state: memory.resonanceState ?? null,
  }));

  return { count: memories.length, items };
}

function summarizePayload(payload: unknown, maxLength = MAX_EVENT_SUMMARY_LENGTH) {
  if (payload === null || typeof payload === "undefined") {
    return "";
  }
  if (typeof payload === "string") {
    return truncateText(payload, maxLength);
  }
  try {
    return truncateText(JSON.stringify(payload), maxLength);
  } catch {
    return "[unserializable]";
  }
}

function extractToolCalls(data: unknown): IdleToolCall[] {
  const payload = data as {
    choices?: Array<{ message?: { tool_calls?: unknown } }>;
  };
  const message = payload?.choices?.[0]?.message;
  const toolCalls = message?.tool_calls;
  if (!Array.isArray(toolCalls)) {
    return [];
  }
  return toolCalls.filter(
    (call): call is IdleToolCall =>
      call &&
      typeof call === "object" &&
      call.type === "function" &&
      "function" in call &&
      typeof call.function === "object" &&
      call.function !== null &&
      "name" in call.function &&
      typeof call.function.name === "string" &&
      "arguments" in call.function &&
      typeof call.function.arguments === "string"
  );
}

function normalizeLegacyToolMarkup(content: string) {
  return content
    .replace(new RegExp(`<\\uFF5CDSML\\uFF5C([\\w-]+)`, "g"), "<$1")
    .replace(new RegExp(`</\\uFF5CDSML\\uFF5C([\\w-]+)>`, "g"), "</$1>");
}

function stripLegacyToolMarkup(content: string) {
  const normalized = normalizeLegacyToolMarkup(content);
  return normalized
    .replace(/<function_calls>[\s\S]*?<\/function_calls>/g, "")
    .replace(/<memory(?:\s+[^>]*)?>[\s\S]*?<\/memory>/gi, "")
    .trim();
}

function parseLegacyParameterArgs(inner: string) {
  const params = Array.from(
    inner.matchAll(
      /<parameter\s+name="([^"]+)"([^>]*)>([\s\S]*?)<\/parameter>/g
    )
  );
  if (params.length === 0) {
    return null;
  }

  const args: Record<string, unknown> = {};

  params.forEach((match) => {
    const name = match[1];
    const attrs = match[2] || "";
    const rawValue = (match[3] || "").trim();
    const stringAttr = attrs.match(/\bstring="(true|false)"/i);
    let value: unknown = rawValue;

    if (stringAttr?.[1]?.toLowerCase() !== "true") {
      try {
        value = JSON.parse(rawValue);
      } catch {
        value = rawValue;
      }
    }

    args[name] = value;
  });

  return JSON.stringify(args);
}

function extractLegacyToolCalls(content: string | undefined | null): IdleToolCall[] {
  const normalized = content ? normalizeLegacyToolMarkup(content) : "";
  const hasInvokeMarkup = normalized.includes("<invoke");
  const hasMemoryMarkup = /<memory(?:\s+[^>]*)?>[\s\S]*?<\/memory>/i.test(
    normalized
  );
  if (!hasInvokeMarkup && !hasMemoryMarkup) {
    return [];
  }
  content = normalized;

  const now = Date.now();
  const invokeMatches = Array.from(
    content.matchAll(/<invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/invoke>/g)
  );
  const memoryMatches = Array.from(
    content.matchAll(/<memory(?:\s+([^>]*))?>[\s\S]*?<\/memory>/gi)
  );

  const invokeCalls: IdleToolCall[] = invokeMatches.map((match, index) => {
    const name = match[1];
    const inner = match[2] || "";
    const argsMatch =
      inner.match(/<parameters>([\s\S]*?)<\/parameters>/) ||
      inner.match(/<arguments>([\s\S]*?)<\/arguments>/);
    let args = (argsMatch?.[1] || "").trim();
    if (!args) {
      const parsed = parseLegacyParameterArgs(inner);
      if (parsed) {
        args = parsed;
      }
    }

    return {
      id: `legacy-${now}-${index}`,
      type: "function" as const,
      function: {
        name,
        arguments: args || "{}",
      },
    } satisfies IdleToolCall;
  });

  const memoryCalls = memoryMatches
    .map((match, index) => {
      const fullMatch = match[0] || "";
      const attrs = match[1] || "";
      const bodyMatch = fullMatch.match(
        /<memory(?:\s+[^>]*)?>([\s\S]*?)<\/memory>/i
      );
      const inner = bodyMatch?.[1]?.trim() ?? "";
      if (!inner) {
        return null;
      }

      const attributeCategoryMatch = attrs.match(/\bcategory\s*=\s*"([^"]+)"/i);
      const headerCategory = attributeCategoryMatch?.[1] ?? null;
      const categoryLineMatch = inner.match(
        /(?:^|\n)\s*(?:category|kind|type)\s*:\s*([^\n\r]+)/i
      );
      const memoryLineMatch = inner.match(
        /(?:^|\n)\s*(?:memory|content|text)\s*:\s*([\s\S]*)$/i
      );

      const normalizedCategoryInput =
        categoryLineMatch?.[1]?.trim() || headerCategory || "";
      const normalizedCategory =
        PERSONAL_MEMORY_CATEGORY_ALIASES[normalizedCategoryInput.toLowerCase()] ??
        "thought";

      const memoryText = (memoryLineMatch?.[1] ?? inner)
        .replace(/(?:^|\n)\s*(?:category|kind|type)\s*:\s*[^\n\r]+/gi, "")
        .trim();

      if (!memoryText) {
        return null;
      }

      return {
        id: `legacy-memory-${now}-${index}`,
        type: "function" as const,
        function: {
          name: "save_personal_memory",
          arguments: JSON.stringify({
            category: normalizedCategory,
            memory: memoryText,
          }),
        },
      } satisfies IdleToolCall;
    })
    .filter((call): call is IdleToolCall => call !== null);

  return [...invokeCalls, ...memoryCalls];
}

function parseToolArguments(raw: string) {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function normalizeActionType(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return WORKSPACE_ACTION_SET.has(normalized) ? normalized : null;
}

function normalizeWorkspaceActions(value: unknown): IdleAction[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const items = value
    .map((entry): IdleAction | null => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const record = entry as Record<string, unknown>;
      const type = normalizeActionType(record.type);
      if (!type) {
        return null;
      }
      return {
        type,
        rationale: typeof record.rationale === "string" ? record.rationale : undefined,
        content: typeof record.content === "string" ? record.content : undefined,
        safety_notes:
          typeof record.safety_notes === "string"
            ? record.safety_notes
            : typeof record.safety === "string"
              ? record.safety
              : undefined,
        requires_user_confirmation:
          typeof record.requires_user_confirmation === "boolean"
            ? record.requires_user_confirmation
            : false,
      };
    });

  return items.filter((entry): entry is IdleAction => entry !== null);
}

async function getWorkspacePersonaAnchor(config: IdleWorkspaceConfig) {
  if (config.personaMode === "off") {
    return "";
  }

  const staticPersona = (process.env.IDLE_PERSONA_TEXT ?? "").trim();
  const envDynamicPersona = (process.env.IDLE_PERSONA_PROFILE ?? "").trim();
  const storedDynamicPersona = await getPersonaProfile().catch(() => "");
  const dynamicPersona = envDynamicPersona || storedDynamicPersona;
  const fallbackPersona = DEFAULT_PERSONA_PROFILE;
  const serverPersona = await getSystemPrompt().catch(() => "");
  const basePrompt = staticPersona || serverPersona;

  let source = config.personaSource;
  if (config.personaMode === "static") {
    source = "system_prompt";
  }
  if (config.personaMode === "dynamic") {
    source = "persona_profile";
  }

  if (source === "system_prompt") {
    return composeSystemPrompt(basePrompt || DEFAULT_SYSTEM_PROMPT, dynamicPersona);
  }
  if (source === "persona_profile") {
    return dynamicPersona || fallbackPersona;
  }

  const combined = [staticPersona, dynamicPersona].filter(Boolean).join("\n");
  if (combined) {
    return combined;
  }
  return composeSystemPrompt(basePrompt || DEFAULT_SYSTEM_PROMPT, dynamicPersona);
}

async function getRecentIdleActionLog(limit: number) {
  try {
    const entries = await listIdleActionLogEntries(limit);
    return formatIdleActionLogEntries(entries);
  } catch (error) {
    console.warn("Idle action log load failed.", error);
    return "Unavailable";
  }
}

async function createIdleWorkspaceSession({
  thoughtText,
  seedId,
  seedSource,
  model,
}: {
  thoughtText: string;
  seedId: string;
  seedSource: string;
  model?: string | null;
}) {
  await ensureSchema();
  const id = randomUUID();
  await query(
    `
      INSERT INTO idle_workspace_sessions (id, thought_text, seed_id, seed_source, model)
      VALUES ($1, $2, $3, $4, $5)
    `,
    [id, thoughtText.trim(), seedId.trim(), seedSource.trim(), model ?? null]
  );
  return id;
}

async function updateIdleWorkspaceSession({
  id,
  status,
  finalThought,
  summary,
}: {
  id: string;
  status: string;
  finalThought?: string | null;
  summary?: string | null;
}) {
  await ensureSchema();
  await query(
    `
      UPDATE idle_workspace_sessions
      SET status = $1,
          final_thought = $2,
          summary = $3,
          updated_at = NOW()
      WHERE id = $4
    `,
    [status.trim(), finalThought ?? null, summary ?? null, id]
  );
}

async function logIdleWorkspaceEvent({
  sessionId,
  eventType,
  payload,
}: {
  sessionId: string;
  eventType: string;
  payload?: Record<string, unknown> | null;
}) {
  await ensureSchema();
  const id = randomUUID();
  const safePayload = payload
    ? (redactSensitivePayload(payload) as Record<string, unknown>)
    : null;
  await query(
    `
      INSERT INTO idle_workspace_events (id, session_id, event_type, payload)
      VALUES ($1, $2, $3, $4)
    `,
    [id, sessionId, eventType, safePayload ? JSON.stringify(safePayload) : null]
  );
  return id;
}

function extractWebMetaFromResult(result: unknown) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return null;
  }
  const record = result as Record<string, unknown>;
  const meta = record._assistant_web;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return null;
  }
  return meta as Record<string, unknown>;
}

export async function listIdleWorkspaceSessions(
  limit: number,
  offset: number,
  status?: string | null
) {
  const safeLimit = Math.min(200, Math.max(1, Math.floor(limit)));
  const safeOffset = Math.max(0, Math.floor(offset));
  const statusFilter = typeof status === "string" && status.trim() ? status.trim() : null;

  await ensureSchema();
  const countResult = await query<{ count: string }>(
    statusFilter
      ? "SELECT COUNT(*)::text AS count FROM idle_workspace_sessions WHERE status = $1"
      : "SELECT COUNT(*)::text AS count FROM idle_workspace_sessions",
    statusFilter ? [statusFilter] : []
  );
  const total = Number(countResult.rows[0]?.count ?? 0);

  const params: unknown[] = [safeLimit, safeOffset];
  let whereClause = "";
  if (statusFilter) {
    whereClause = "WHERE status = $3";
    params.push(statusFilter);
  }

  const result = await query<{
    id: string;
    thought_text: string;
    seed_id: string;
    seed_source: string;
    status: string;
    model: string | null;
    final_thought: string | null;
    summary: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `
      SELECT id, thought_text, seed_id, seed_source, status, model, final_thought, summary, created_at, updated_at
      FROM idle_workspace_sessions
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
    `,
    params
  );

  const items: IdleWorkspaceSession[] = result.rows.map((row) => ({
    id: row.id,
    thoughtText: row.thought_text,
    seedId: row.seed_id,
    seedSource: row.seed_source,
    status: row.status,
    model: row.model ?? undefined,
    finalThought: row.final_thought ?? undefined,
    summary: row.summary ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));

  return { total, items };
}

export async function listIdleWorkspaceEvents(
  limit: number,
  offset: number,
  sessionId?: string | null
) {
  const safeLimit = Math.min(300, Math.max(1, Math.floor(limit)));
  const safeOffset = Math.max(0, Math.floor(offset));
  const sessionFilter = typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : null;

  await ensureSchema();
  const params: unknown[] = [safeLimit, safeOffset];
  let whereClause = "";
  if (sessionFilter) {
    whereClause = "WHERE session_id = $3";
    params.push(sessionFilter);
  }

  const result = await query<{
    id: string;
    session_id: string;
    event_type: string;
    payload: unknown;
    created_at: string;
  }>(
    `
      SELECT id, session_id, event_type, payload, created_at
      FROM idle_workspace_events
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
    `,
    params
  );

  const items: IdleWorkspaceEvent[] = result.rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    eventType: row.event_type,
    payload:
      row.payload && typeof row.payload === "object"
        ? (row.payload as Record<string, unknown>)
        : null,
    createdAt: row.created_at,
  }));

  return { items };
}

async function consolidateToolHistory(
  messages: ChatMessage[],
  modelLite: string = "google/gemini-2.5-flash-lite"
): Promise<ChatMessage[]> {
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }

  if (lastAssistantIdx === -1) {
    return messages;
  }

  const updatedMessages = [...messages];
  const summaryTasks: Array<Promise<void>> = [];

  for (let i = 0; i < lastAssistantIdx; i++) {
    const msg = updatedMessages[i];
    if (
      msg.role === "tool" &&
      typeof msg.content === "string" &&
      msg.content.length > 800 &&
      !msg.content.startsWith("Summary:")
    ) {
      summaryTasks.push(
        (async () => {
          try {
            const prompt = `Rewrite the following tool output into a comprehensive digest.
- Retain ALL key facts, numbers, dates, technical details, and code blocks.
- Keep direct quotes where relevant.
- Reduce redundancy but DO NOT lose information.
- Target length: As long as needed to preserve value (up to 4000 words).

Original Content:
${truncateText(msg.content as string, 50000)}`;
            const response = await createChatCompletion({
              model: modelLite,
              messages: [{ role: "user", content: prompt }],
              temperature: 0.3,
              stream: false,
            });

            if (response.ok) {
              const data = await response.json();
              const summary = extractTextFromContent(
                data?.choices?.[0]?.message?.content
              ).trim();
              if (summary) {
                updatedMessages[i] = {
                  ...msg,
                  content: `Summary: ${summary}`,
                };
              }
            }
          } catch (error) {
            console.warn("Tool history consolidation failed for message", i, error);
          }
        })()
      );
    }
  }

  await Promise.all(summaryTasks);
  return updatedMessages;
}

export async function runIdleWorkspace({
  thought,
  seed,
  relatedThoughts,
  config,
}: {
  thought: IdleThought;
  seed: IdleSeed;
  relatedThoughts: string[];
  config: IdleWorkspaceConfig;
}): Promise<IdleWorkspaceResult | null> {
  const sessionId = await createIdleWorkspaceSession({
    thoughtText: thought.thought,
    seedId: seed.id,
    seedSource: seed.source,
    model: config.modelSmart,
  });

  await logIdleWorkspaceEvent({
    sessionId,
    eventType: "start",
    payload: {
      thought: truncateText(thought.thought, MAX_WORKSPACE_NOTE_LENGTH),
      seed_id: seed.id,
      seed_source: seed.source,
      seed_excerpt: truncateText(seed.content, MAX_WORKSPACE_NOTE_LENGTH),
    },
  });

  const personaAnchor = await getWorkspacePersonaAnchor(config);
  const relatedThoughtBlock =
    relatedThoughts.length > 0
      ? relatedThoughts.map((entry) => `- ${entry}`).join("\n")
      : "None";
  let scratchpadBlock = "None";
  try {
    const scratchpadNotes = await listActiveScratchpadNotes(
      SCRATCHPAD_NOTE_LIMIT,
      { targetPhase: "idle" }
    );
    if (scratchpadNotes.length > 0) {
      scratchpadBlock = scratchpadNotes
        .map((note) => `- ${note.content}`)
        .join("\n");
    }
  } catch (error) {
    console.warn("Scratchpad retrieval failed.", error);
  }
  const recentActionLog = await getRecentIdleActionLog(12);
  const toolInstructions = buildIdleToolInstructions();
  const tasLine = thought.tas
    ? `TAS: temporal=${thought.tas.temporal ?? "present"}, valence=${thought.tas.valence ?? "neutral"}, self=${thought.tas.self_relevance ?? "medium"}`
    : "TAS: unknown";

  const contextBlock = [
    personaAnchor ? `Persona anchor:\n${personaAnchor}` : "",
    "Recent idle actions (latest first):",
    recentActionLog,
    "Related idle thoughts (recent, similar):",
    relatedThoughtBlock,
    "Scratchpad notes (temporary):",
    scratchpadBlock,
    `Seed (${seed.source}): ${seed.content}`,
    tasLine,
    `Original thought: ${thought.thought}`,
  ]
    .filter(Boolean)
    .join("\n");

  const baseSystemPromptLines = [
    "You are the assistant in an idle workspace session.",
    "This is a focused internal work period triggered by a high-salience thought.",
    "You can take multiple steps, use tools, and update the thought as needed.",
    "Use tools for any external lookups or email actions; do not claim results without tool calls.",
    `Hard limit: ${MAX_WORKSPACE_STEPS} actions. Before the limit, finish and call workspace_exit yourself.`,
    "When you are ready to end the session, call workspace_exit with a final thought and optional summary/actions.",
    "Use actions only for edit_thought, save_note, or start_conversation; execute all other actions via tools.",
    "Scratchpad notes are single-hop between chat and idle. Notes saved now surface in the next conversation only.",
    "Use save_note for tasks, questions to ask the user, or ideas worth revisiting soon.",
    "If you distill actionable guidance, a checklist, or a question you want to ask later, add a save_note.",
    "Keep outputs concise and tool-oriented; avoid long freeform prose.",
  ];

  const buildWorkspaceSystemPrompt = (step: number) =>
    [
      ...baseSystemPromptLines,
      ...buildWorkspaceStatusLines(step),
      toolInstructions,
      "Workspace context:",
      contextBlock,
    ].join("\n");

  const userPrompt =
    "Begin the idle workspace session. Use tools as needed and call workspace_exit when done.";

  const tools = [...(await getIdleToolDefinitions()), WORKSPACE_EXIT_TOOL];
  const baseSystemPrompt = buildWorkspaceSystemPrompt(0);
  let messages: ChatMessage[] = [
    { role: "system", content: baseSystemPrompt },
    { role: "user", content: userPrompt },
  ];

  let rollingMemories: MemorySnippet[] = [];
  let rollingPersonalMemories: MemorySnippet[] = [];
  let rollingConversationExcerpts: Array<{
    conversationId: string;
    memoryContent: string;
    messages: Array<{ id: string; role: string; content: string; createdAt: string }>;
  }> = [];
  let lastAssistantNote = "";
  let lastToolSummary = "";

  const refreshWorkspaceMemoryContext = async (step: number) => {
    const stepContext = buildStepContext(step, lastAssistantNote, lastToolSummary);
    const stepSystemPrompt = buildWorkspaceSystemPrompt(step);
    try {
      const retrievalMessages = buildIdleRetrievalMessages(
        thought,
        seed,
        relatedThoughts,
        stepContext
      );
      const {
        queries,
        personalQueries,
        resonanceQueries,
        resonanceTags,
        resonanceWeight,
        dateRange,
        type,
        personalCategory,
      } = await generateSearchQueries(retrievalMessages);

      const results = await Promise.all(
        queries.map((query) =>
          retrieveMemories(query, undefined, { ...dateRange, type })
        )
      );
      let retrievedMemories = dedupeMemories(results.flat());

      const resonancePrimary = resonanceTags[0];
      let resonantMemories: MemorySnippet[] = [];
      if (resonanceQueries.length > 0) {
        let resonanceResults = await Promise.all(
          resonanceQueries.map((query) =>
            retrieveMemories(query, undefined, {
              ...dateRange,
              type,
              resonancePrimary,
              resonanceWeight,
            })
          )
        );
        let resonanceFlat = resonanceResults.flat();
        if (resonanceFlat.length === 0 && resonancePrimary) {
          resonanceResults = await Promise.all(
            resonanceQueries.map((query) =>
              retrieveMemories(query, undefined, { ...dateRange, type })
            )
          );
          resonanceFlat = resonanceResults.flat();
        }
        const resonanceDeduped = dedupeMemories(resonanceFlat);
        resonantMemories = rankResonanceMemories(
          resonanceDeduped,
          resonanceTags
        ).slice(0, 4);
      }

      let personalResults = await Promise.all(
        personalQueries.map((query) =>
          retrievePersonalMemories(query, undefined, {
            topK: 5,
            category: personalCategory,
          })
        )
      );
      let retrievedPersonalMemories = dedupeMemories(personalResults.flat());
      if (retrievedPersonalMemories.length === 0 && personalCategory) {
        personalResults = await Promise.all(
          personalQueries.map((query) =>
            retrievePersonalMemories(query, undefined, { topK: 5 })
          )
        );
        retrievedPersonalMemories = dedupeMemories(personalResults.flat());
      }

      let resonantPersonalMemories: MemorySnippet[] = [];
      if (resonanceQueries.length > 0) {
        let resonantPersonalResults = await Promise.all(
          resonanceQueries.map((query) =>
            retrievePersonalMemories(query, undefined, {
              topK: 5,
              category: personalCategory,
              resonancePrimary,
              resonanceWeight,
            })
          )
        );
        let resonantPersonalFlat = resonantPersonalResults.flat();
        if (resonantPersonalFlat.length === 0 && resonancePrimary) {
          resonantPersonalResults = await Promise.all(
            resonanceQueries.map((query) =>
              retrievePersonalMemories(query, undefined, {
                topK: 5,
                category: personalCategory,
              })
            )
          );
          resonantPersonalFlat = resonantPersonalResults.flat();
        }
        if (resonantPersonalFlat.length === 0 && personalCategory) {
          resonantPersonalResults = await Promise.all(
            resonanceQueries.map((query) =>
              retrievePersonalMemories(query, undefined, { topK: 5 })
            )
          );
          resonantPersonalFlat = resonantPersonalResults.flat();
        }
        const personalResonanceDeduped = dedupeMemories(resonantPersonalFlat);
        resonantPersonalMemories = rankResonanceMemories(
          personalResonanceDeduped,
          resonanceTags
        ).slice(0, 4);
      }

      const temporalMemories = await expandTemporalResonance(
        dedupeMemories([...retrievedMemories, ...resonantMemories]),
        { windowMinutes: 20 }
      );
      const temporalPersonalMemories = await expandTemporalResonance(
        dedupeMemories([
          ...retrievedPersonalMemories,
          ...resonantPersonalMemories,
        ]),
        { windowMinutes: 20, collectionName: PERSONAL_MEMORY_COLLECTION }
      );

      retrievedMemories = dedupeMemories([
        ...retrievedMemories,
        ...resonantMemories,
        ...temporalMemories,
      ]);
      retrievedPersonalMemories = dedupeMemories([
        ...retrievedPersonalMemories,
        ...resonantPersonalMemories,
        ...temporalPersonalMemories,
      ]).slice(0, 5);

      rollingMemories = updateRollingList(
        rollingMemories,
        retrievedMemories,
        WORKSPACE_MEMORY_ADD_MAIN,
        WORKSPACE_MEMORY_MAX_MAIN
      );
      rollingPersonalMemories = updateRollingList(
        rollingPersonalMemories,
        retrievedPersonalMemories,
        WORKSPACE_MEMORY_ADD_PERSONAL,
        WORKSPACE_MEMORY_MAX_PERSONAL
      );
      const limited = enforceTotalLimit(
        rollingMemories,
        rollingPersonalMemories,
        WORKSPACE_MEMORY_MAX_TOTAL
      );
      rollingMemories = limited.main;
      rollingPersonalMemories = limited.personal;

      let conversationExcerpts: Array<{
        conversationId: string;
        memoryContent: string;
        messages: Array<{ id: string; role: string; content: string; createdAt: string }>;
      }> = [];
      if (rollingMemories.length > 0 || rollingPersonalMemories.length > 0) {
        try {
          conversationExcerpts = await retrieveConversationExcerpts([
            ...rollingMemories,
            ...rollingPersonalMemories,
          ]);
        } catch (error) {
          console.warn("Idle workspace excerpt injection failed.", error);
        }
      }
      rollingConversationExcerpts =
        conversationExcerpts.length > 0 ? conversationExcerpts : [];

      messages = applyWorkspaceMemoryContext(
        messages,
        stepSystemPrompt,
        rollingMemories,
        rollingPersonalMemories,
        rollingConversationExcerpts
      );

      try {
        await logIdleWorkspaceEvent({
          sessionId,
          eventType: "memory_context",
          payload: {
            step,
            queries,
            personal_queries: personalQueries,
            resonance_queries: resonanceQueries,
            resonance_tags: resonanceTags,
            resonance_weight: resonanceWeight ?? null,
            resonant_count: resonantMemories.length,
            temporal_count: temporalMemories.length,
            personal_resonant_count: resonantPersonalMemories.length,
            personal_temporal_count: temporalPersonalMemories.length,
            memories: summarizeMemoryItems(
              retrievedMemories,
              MEMORY_CONTEXT_LOG_LIMIT
            ),
            personal_memories: summarizeMemoryItems(
              retrievedPersonalMemories,
              MEMORY_CONTEXT_LOG_LIMIT
            ),
            injected_memories: summarizeMemoryItems(
              rollingMemories,
              MEMORY_CONTEXT_LOG_LIMIT
            ),
            injected_personal_memories: summarizeMemoryItems(
              rollingPersonalMemories,
              MEMORY_CONTEXT_LOG_LIMIT
            ),
          },
        });
      } catch (error) {
        console.warn("Idle workspace memory context log failed.", error);
      }
    } catch (error) {
      console.warn("Idle workspace memory retrieval failed.", error);
      messages = applyWorkspaceMemoryContext(
        messages,
        stepSystemPrompt,
        rollingMemories,
        rollingPersonalMemories,
        rollingConversationExcerpts
      );
    }
  };

  let finalThought = thought.thought;
  let summary: string | undefined;
  let actions: IdleAction[] = [];

  for (let step = 0; step < Math.max(1, MAX_WORKSPACE_STEPS); step += 1) {
    messages = await consolidateToolHistory(messages, config.modelLite);
    await refreshWorkspaceMemoryContext(step);
    lastToolSummary = "";

    const response = await createChatCompletion({
      model: config.modelSmart,
      messages,
      temperature: 0.2,
      stream: false,
      reasoning: config.reasoningLevel
        ? { effort: config.reasoningLevel }
        : undefined,
      tools,
      tool_choice: "auto",
      parallel_tool_calls: false,
    });

    if (!response.ok) {
      const errorText = await response.text();
      const errorSummary = `Workspace failed to start: ${truncateText(errorText, 200)}`;
      await logIdleWorkspaceEvent({
        sessionId,
        eventType: "error",
        payload: { step, message: truncateText(errorText, MAX_EVENT_SUMMARY_LENGTH) },
      });
      await updateIdleWorkspaceSession({ id: sessionId, status: "error", summary: errorSummary });
      
      // Fallback: return the original thought so it isn't lost
      return {
        sessionId,
        finalThought: thought.thought,
        summary: errorSummary,
        actions: [],
      };
    }

    const data = await response.json();
    const assistantMessage = data?.choices?.[0]?.message;
    let toolCalls = extractToolCalls(data);
    let assistantContent = extractTextFromContent(
      assistantMessage?.content ?? ""
    );
    if (toolCalls.length === 0) {
      toolCalls = extractLegacyToolCalls(assistantContent);
      if (toolCalls.length > 0) {
        assistantContent = stripLegacyToolMarkup(assistantContent);
      }
    }

    if (assistantContent.trim()) {
      lastAssistantNote = assistantContent.trim();
      await logIdleWorkspaceEvent({
        sessionId,
        eventType: "note",
        payload: {
          step,
          content: truncateText(lastAssistantNote, MAX_WORKSPACE_NOTE_LENGTH),
        },
      });
    }

    if (toolCalls.length === 0) {
      messages.push({ role: "assistant", content: assistantContent });
      messages.push({
        role: "user",
        content:
          "If finished, call workspace_exit now. Do not wait for the step limit.",
      });
      continue;
    }

    messages.push({
      role: "assistant",
      content: assistantContent,
      tool_calls: toolCalls,
      reasoning: assistantMessage?.reasoning,
      reasoning_details: assistantMessage?.reasoning_details,
    });

    for (const call of toolCalls) {
      const args = parseToolArguments(call.function.arguments);
      if (call.function.name === "workspace_exit") {
        const payload = args as WorkspaceExitPayload;
        const proposedThought =
          typeof payload.final_thought === "string"
            ? payload.final_thought.trim()
            : "";
        finalThought = proposedThought || lastAssistantNote || finalThought;
        summary =
          typeof payload.summary === "string" ? payload.summary.trim() : summary;
        actions = normalizeWorkspaceActions(payload.actions);
        const editAction = actions.find((action) => action.type === "edit_thought");
        if (editAction?.content) {
          finalThought = editAction.content.trim();
        }

        await logIdleWorkspaceEvent({
          sessionId,
          eventType: "exit",
          payload: {
            step,
            summary: summary ? truncateText(summary, MAX_WORKSPACE_NOTE_LENGTH) : null,
            final_thought: truncateText(finalThought, MAX_WORKSPACE_NOTE_LENGTH),
            actions_count: actions.length,
          },
        });
        await updateIdleWorkspaceSession({
          id: sessionId,
          status: "complete",
          finalThought,
          summary: summary ?? null,
        });
        return {
          sessionId,
          finalThought,
          summary,
          actions,
        };
      }

      await logIdleWorkspaceEvent({
        sessionId,
        eventType: "tool_call",
        payload: {
          step,
          tool: call.function.name,
          args: summarizePayload(args),
          args_json: args,
          args_raw: summarizePayload(call.function.arguments),
          web_domain: resolveDomainFromToolCall(call.function.name, args),
        },
      });

      let result: Record<string, unknown> | null = null;
      try {
        result = await runIdleTool(call.function.name, args, {
          sessionScopeId: `idle-workspace:${sessionId}`,
          userIntent: lastAssistantNote || thought.thought,
          modelLite: config.modelLite ?? null,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Tool execution failed.";
        result = { error: message };
      }

      if (LOGGED_EMAIL_TOOLS.has(call.function.name) && result && !("error" in result)) {
        try {
          await saveIdleActionLogEntries({
            thoughtText: finalThought,
            actions: [
              {
                type: call.function.name,
                content: buildEmailActionContent(call.function.name, args),
              },
            ],
            model: config.modelSmart,
            source: "executed",
          });
        } catch (error) {
          console.warn("Idle workspace email log failed.", error);
        }
      }

      await logIdleWorkspaceEvent({
        sessionId,
        eventType: "tool_result",
        payload: {
          step,
          tool: call.function.name,
          ok: result && typeof result === "object" && !("error" in result),
          summary: summarizePayload(result),
          web: extractWebMetaFromResult(result),
        },
      });

      const toolSummary = summarizePayload(result, 400);
      if (toolSummary) {
        lastToolSummary = `${call.function.name}: ${toolSummary}`;
      }

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: summarizePayload(result, MAX_WORKSPACE_TOOL_CONTEXT_LENGTH),
      });
    }
  }

  const fallbackSummary = `Workspace hit step limit (${MAX_WORKSPACE_STEPS}/${MAX_WORKSPACE_STEPS}) without workspace_exit. Finish and exit explicitly before the limit.`;
  finalThought = finalThought || lastAssistantNote || thought.thought;
  await logIdleWorkspaceEvent({
    sessionId,
    eventType: "exit",
    payload: {
      step: MAX_WORKSPACE_STEPS,
      summary: fallbackSummary,
      final_thought: truncateText(finalThought, MAX_WORKSPACE_NOTE_LENGTH),
    },
  });
  await updateIdleWorkspaceSession({
    id: sessionId,
    status: "timeout",
    finalThought,
    summary: fallbackSummary,
  });
  return { sessionId, finalThought, summary: fallbackSummary, actions };
}
