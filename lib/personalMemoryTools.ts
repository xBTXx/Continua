import {
  PERSONAL_MEMORY_CATEGORIES,
  PERSONAL_MEMORY_COLLECTION,
  savePersonalMemory,
} from "./personalMemory";
import { countVectors } from "./vector";
import { ensureSchema, query } from "./db";

export type PersonalMemoryToolStatus = {
  id: string;
  label: string;
  status: "ok" | "error";
  details: string[];
};

type PersonalMemoryToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

type PersonalMemoryToolContext = {
  apiKey?: string;
  model?: string;
  conversationId?: string | null;
  sourceMessageIds?: string[];
};

type PersonalMemoryToolArguments = Record<string, unknown>;

export const PERSONAL_MEMORY_TOOL_NAMES = [
  "save_personal_memory",
] as const;

const PERSONAL_MEMORY_MESSAGE_LIMIT = 20;

export function personalMemoryToolsEnabled() {
  return process.env.PERSONAL_MEMORY_TOOLS_ENABLED !== "false";
}

export async function getPersonalMemoryToolStatus(): Promise<PersonalMemoryToolStatus[]> {
  if (!personalMemoryToolsEnabled()) {
    return [
      {
        id: "personal-memory",
        label: "Assistant memory",
        status: "error",
        details: ["Disabled (PERSONAL_MEMORY_TOOLS_ENABLED=false)."],
      },
    ];
  }

  try {
    const count = await countVectors(PERSONAL_MEMORY_COLLECTION);
    return [
      {
        id: "personal-memory",
        label: "Assistant memory",
        status: "ok",
        details: [
          `Collection: ${PERSONAL_MEMORY_COLLECTION}.`,
          `Entries: ${count}.`,
        ],
      },
    ];
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to reach ChromaDB.";
    return [
      {
        id: "personal-memory",
        label: "Assistant memory",
        status: "error",
        details: [message],
      },
    ];
  }
}

export function getPersonalMemoryToolDefinitions(): PersonalMemoryToolDefinition[] {
  if (!personalMemoryToolsEnabled()) {
    return [];
  }

  const resonanceWeights = ["core", "pivot", "notable", "transient"];
  const resonanceStates = [
    "expansive",
    "protective",
    "quiet",
    "focused",
    "playful",
    "tender",
    "analytical",
    "restless",
    "grounded",
  ];

  return [
    {
      type: "function",
      function: {
        name: "save_personal_memory",
        description:
          "Save a private personal memory about the assistant's own thoughts, feelings, preferences, or perspective, with a category.",
        parameters: {
          type: "object",
          properties: {
            memory: {
              type: "string",
              description:
                "A concise first-person memory to store in the assistant's personal space.",
            },
            category: {
              type: "string",
              enum: PERSONAL_MEMORY_CATEGORIES,
              description:
                "Category for this memory (feeling, experience, thought, view, opinion).",
            },
            resonance_tags: {
              type: "array",
              items: { type: "string" },
              description:
                "Optional freeform resonance tags describing the vibe or theme.",
            },
            resonance_weight: {
              type: "string",
              enum: resonanceWeights,
              description:
                "Optional significance weight (core, pivot, notable, transient).",
            },
            resonance_intensity: {
              type: "number",
              description: "Optional intensity level (1-5).",
            },
            resonance_state: {
              type: "string",
              enum: resonanceStates,
              description: "Optional internal state tag.",
            },
            resonance_motifs: {
              type: "array",
              items: { type: "string" },
              description: "Optional motifs or themes (freeform).",
            },
            resonance_primary: {
              type: "string",
              description: "Optional primary resonance tag to use for filtering.",
            },
          },
          required: ["memory", "category"],
        },
      },
    },
  ];
}

function pickMemoryText(args: PersonalMemoryToolArguments) {
  if (typeof args.memory === "string") {
    return args.memory;
  }
  if (typeof args.content === "string") {
    return args.content;
  }
  if (typeof args.text === "string") {
    return args.text;
  }
  return "";
}

function pickMemoryCategory(args: PersonalMemoryToolArguments) {
  if (typeof args.category === "string") {
    return args.category;
  }
  if (typeof args.kind === "string") {
    return args.kind;
  }
  if (typeof args.type === "string") {
    return args.type;
  }
  return "";
}

function pickStringArray(args: PersonalMemoryToolArguments, key: string) {
  const value = args[key];
  if (Array.isArray(value)) {
    return value.filter((entry) => typeof entry === "string");
  }
  if (typeof value === "string") {
    return [value];
  }
  return [];
}

function pickStringValue(args: PersonalMemoryToolArguments, key: string) {
  return typeof args[key] === "string" ? (args[key] as string) : null;
}

function pickNumberValue(args: PersonalMemoryToolArguments, key: string) {
  const value = args[key];
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

async function listRecentConversationMessageIds(
  conversationId: string,
  limit = PERSONAL_MEMORY_MESSAGE_LIMIT
) {
  await ensureSchema();
  const result = await query<{ id: string }>(
    `
      SELECT id
      FROM messages
      WHERE conversation_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `,
    [conversationId, limit]
  );
  return result.rows.map((row) => row.id).reverse();
}

export async function runPersonalMemoryTool(
  name: string,
  args: PersonalMemoryToolArguments,
  context?: PersonalMemoryToolContext
) {
  if (!personalMemoryToolsEnabled()) {
    throw new Error("Personal memory tool is disabled.");
  }
  if (name !== "save_personal_memory") {
    throw new Error(`Unknown personal memory tool: ${name}`);
  }

  const memoryText = pickMemoryText(args).trim();
  if (!memoryText) {
    throw new Error("save_personal_memory requires a memory string.");
  }
  const category = pickMemoryCategory(args).trim();
  if (!category) {
    throw new Error(
      "save_personal_memory requires a category (feeling, experience, thought, view, opinion)."
    );
  }

  let sourceMessageIds = context?.sourceMessageIds ?? [];
  if (sourceMessageIds.length === 0 && context?.conversationId) {
    try {
      sourceMessageIds = await listRecentConversationMessageIds(
        context.conversationId
      );
    } catch (error) {
      console.warn("Unable to load message ids for personal memory.", error);
    }
  }
  const sourceMessageIdsRaw =
    sourceMessageIds.length > 0 ? JSON.stringify(sourceMessageIds) : null;

  return savePersonalMemory({
    content: memoryText,
    category,
    apiKey: context?.apiKey,
    model: context?.model,
    conversationId: context?.conversationId ?? null,
    resonanceTags: pickStringArray(args, "resonance_tags"),
    resonanceWeight: pickStringValue(args, "resonance_weight"),
    resonanceIntensity: pickNumberValue(args, "resonance_intensity"),
    resonanceState: pickStringValue(args, "resonance_state"),
    resonanceMotifs: pickStringArray(args, "resonance_motifs"),
    resonancePrimary: pickStringValue(args, "resonance_primary"),
    metadata:
      sourceMessageIdsRaw
        ? {
            source_message_ids: sourceMessageIdsRaw,
            source_message_start_id: sourceMessageIds[0] ?? null,
            source_message_end_id:
              sourceMessageIds[sourceMessageIds.length - 1] ?? null,
            source_message_count: sourceMessageIds.length,
          }
        : undefined,
  });
}
