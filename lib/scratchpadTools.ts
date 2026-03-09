import {
  deleteScratchpadNote,
  listScratchpadNotes,
  saveScratchpadNote,
  updateScratchpadNote,
} from "./scratchpad";

type ScratchpadToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

type ScratchpadToolContext = {
  model?: string;
  conversationId?: string | null;
  source?: "active_chat" | "idle_state";
};

type ScratchpadToolArguments = Record<string, unknown>;

export const SCRATCHPAD_TOOL_NAMES = [
  "save_note",
  "list_notes",
  "edit_note",
  "delete_note",
] as const;

export function scratchpadToolsEnabled() {
  return process.env.SCRATCHPAD_TOOLS_ENABLED !== "false";
}

export function getScratchpadToolDefinitions(): ScratchpadToolDefinition[] {
  if (!scratchpadToolsEnabled()) {
    return [];
  }

  return [
    {
      type: "function",
      function: {
        name: "save_note",
        description:
          "Save a temporary scratchpad note for the next idle session.",
        parameters: {
          type: "object",
          properties: {
            note: {
              type: "string",
              description:
                "A concise reminder, task, or question the assistant wants to revisit later.",
            },
          },
          required: ["note"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_notes",
        description: "List scratchpad notes (active by default).",
        parameters: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: ["active", "consumed", "all"],
              description: "Which notes to list (default active).",
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 100,
              description: "Max notes to return (default 12).",
            },
            offset: {
              type: "integer",
              minimum: 0,
              description: "Offset for pagination (default 0).",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "edit_note",
        description: "Update the content of an existing scratchpad note.",
        parameters: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Scratchpad note id.",
            },
            content: {
              type: "string",
              description: "Updated note content.",
            },
          },
          required: ["id", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "delete_note",
        description: "Delete a scratchpad note by id.",
        parameters: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Scratchpad note id.",
            },
          },
          required: ["id"],
        },
      },
    },
  ];
}

function pickNoteText(args: ScratchpadToolArguments) {
  if (typeof args.note === "string") {
    return args.note;
  }
  if (typeof args.content === "string") {
    return args.content;
  }
  if (typeof args.text === "string") {
    return args.text;
  }
  return "";
}

function pickNoteId(args: ScratchpadToolArguments) {
  if (typeof args.id === "string") {
    return args.id;
  }
  if (typeof args.note_id === "string") {
    return args.note_id;
  }
  if (typeof args.noteId === "string") {
    return args.noteId;
  }
  return "";
}

function normalizeStatus(args: ScratchpadToolArguments) {
  if (typeof args.status !== "string") {
    return "active";
  }
  const normalized = args.status.trim().toLowerCase();
  if (normalized === "active" || normalized === "consumed" || normalized === "all") {
    return normalized;
  }
  return "active";
}

function normalizeNumber(
  value: unknown,
  fallback?: number
) {
  const parsed =
    typeof value === "number" ? value : Number(value ?? Number.NaN);
  if (Number.isFinite(parsed)) {
    return Math.floor(parsed);
  }
  return fallback;
}

export async function runScratchpadTool(
  name: string,
  args: ScratchpadToolArguments,
  context?: ScratchpadToolContext
) {
  if (!scratchpadToolsEnabled()) {
    throw new Error("Scratchpad tool is disabled.");
  }
  if (name === "save_note") {
    const noteText = pickNoteText(args).trim();
    if (!noteText) {
      throw new Error("save_note requires a note string.");
    }

    const source = context?.source === "idle_state" ? "idle_state" : "active_chat";
    const targetPhase = source === "idle_state" ? "active" : "idle";
    const idleQueue = source === "idle_state" ? "skip" : "allow";

    return saveScratchpadNote({
      content: noteText,
      model: context?.model,
      idleQueue,
      targetPhase,
      metadata: {
        source,
        note_type: "save_note",
        conversation_id: context?.conversationId ?? null,
      },
    });
  }

  if (name === "list_notes") {
    const limit = normalizeNumber(args.limit, undefined);
    const offset = normalizeNumber(args.offset, undefined);
    return listScratchpadNotes({
      status: normalizeStatus(args),
      limit,
      offset,
    });
  }

  if (name === "edit_note") {
    const noteId = pickNoteId(args).trim();
    const content = pickNoteText(args).trim();
    if (!noteId) {
      throw new Error("edit_note requires a note id.");
    }
    if (!content) {
      throw new Error("edit_note requires updated content.");
    }
    const updated = await updateScratchpadNote(noteId, content);
    if (!updated) {
      return { error: "Scratchpad note not found." };
    }
    return { status: "ok", note: updated };
  }

  if (name === "delete_note") {
    const noteId = pickNoteId(args).trim();
    if (!noteId) {
      throw new Error("delete_note requires a note id.");
    }
    const deleted = await deleteScratchpadNote(noteId);
    if (deleted === 0) {
      return { error: "Scratchpad note not found." };
    }
    return { status: "ok", deleted };
  }

  throw new Error(`Unknown scratchpad tool: ${name}`);
}
