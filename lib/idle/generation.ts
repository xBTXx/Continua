import { createChatCompletion, ChatMessage } from "../openrouter";
import { extractTextFromContent } from "../chatContent";
import { formatIdleActionLogEntries, listIdleActionLogEntries, IdleAction } from "../idleActions";
import {
  listActiveScratchpadNotes,
  saveScratchpadNote,
  SCRATCHPAD_NOTE_LIMIT,
} from "../scratchpad";
import { buildIdleToolInstructions, getIdleToolDefinitions } from "../idleTooling";
import { formatDateTime } from "../chatUtils";
import { RECENT_ACTION_LOG_LIMIT } from "./constants";
import {
  IdleSeed,
  IdleThought,
  IdleConfig,
  IdleActionPlan,
} from "./types";
import {
  formatRecentThoughts,
  formatSeedMetadata,
  parseJsonObject,
  parseIdleThoughtResponse,
  parseIdleThoughtReviewResponse,
  parseIdleActionPlanResponse,
} from "./utils";
import { buildSeedList } from "./seeds";
import { getPersonaAnchor } from "./persona";
import { runIdleToolLoop } from "./tools";

const IDLE_RESONANCE_WEIGHTS = ["core", "pivot", "notable", "transient"] as const;
const IDLE_RESONANCE_STATES = [
  "expansive",
  "protective",
  "quiet",
  "focused",
  "playful",
  "tender",
  "analytical",
  "restless",
  "grounded",
] as const;
const IDLE_RESONANCE_TAG_GUIDE = [
  "discovery",
  "curiosity",
  "breakthrough",
  "alignment",
  "attunement",
  "vulnerability",
  "intimacy",
  "reflection",
  "awe",
  "expansion",
  "friction",
  "boundary",
  "uncertainty",
  "quiet",
  "grounded",
  "care",
  "repair",
  "play",
  "delight",
  "flow",
  "focus",
  "commitment",
];
const IDLE_RESONANCE_WEIGHT_SET = new Set<string>(IDLE_RESONANCE_WEIGHTS);
const IDLE_RESONANCE_STATE_SET = new Set<string>(IDLE_RESONANCE_STATES);

type IdleResonanceMetadata = {
  resonanceTags: string[];
  resonanceWeight: string | null;
  resonanceIntensity: number | null;
  resonanceState: string | null;
  resonanceMotifs: string[];
};

function normalizeTagList(value: unknown, limit = 3): string[] {
  if (!value) {
    return [];
  }
  const list = Array.isArray(value) ? value : [value];
  const normalized = list
    .filter((entry) => typeof entry === "string")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const unique = Array.from(new Set(normalized));
  return unique.slice(0, Math.max(0, limit));
}

function normalizeResonanceWeight(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return IDLE_RESONANCE_WEIGHT_SET.has(normalized) ? normalized : null;
}

function normalizeResonanceState(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return IDLE_RESONANCE_STATE_SET.has(normalized) ? normalized : null;
}

function normalizeResonanceIntensity(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  if (!Number.isFinite(parsed)) {
    return null;
  }
  const rounded = Math.round(parsed);
  if (!Number.isFinite(rounded)) {
    return null;
  }
  return Math.min(5, Math.max(1, rounded));
}

async function getRecentIdleActionLog() {
  try {
    const entries = await listIdleActionLogEntries(RECENT_ACTION_LOG_LIMIT);
    return formatIdleActionLogEntries(entries);
  } catch (error) {
    console.warn("Idle action log load failed.", error);
    return "Unavailable";
  }
}

export async function generateIdleResonanceMetadata(
  thought: IdleThought,
  seed: IdleSeed,
  config: IdleConfig
): Promise<IdleResonanceMetadata | null> {
  const seedMetadata = formatSeedMetadata(seed);
  const tasLine = thought.tas
    ? `TAS: temporal=${thought.tas.temporal ?? "present"}, valence=${thought.tas.valence ?? "neutral"
    }, self=${thought.tas.self_relevance ?? "medium"}, novelty=${thought.tas.novelty ?? "medium"
    }`
    : "TAS: unknown";

  const systemPrompt = [
    "You are labeling a single personal memory from the assistant's idle state.",
    "Return resonance metadata with a light touch (broad, not overfitted).",
    "Resonance tags: 1-3 short tags. Freeform tags are allowed.",
    `Suggested tags: ${IDLE_RESONANCE_TAG_GUIDE.join(", ")}.`,
    `Resonance weight: ${IDLE_RESONANCE_WEIGHTS.join(", ")}.`,
    "Resonance intensity: 1-5.",
    `Resonance state: ${IDLE_RESONANCE_STATES.join(", ")}.`,
    "Resonance motifs: 0-3 short phrases.",
    "Output only JSON.",
  ].join("\n");

  const userPrompt = [
    `Thought: ${thought.thought}`,
    `Seed source: ${seed.source}`,
    seedMetadata ? `Seed metadata: ${seedMetadata}` : "",
    tasLine,
    "",
    "Return JSON:",
    "{\"resonance_tags\":[\"...\"],\"resonance_weight\":\"transient\",\"resonance_intensity\":2,\"resonance_state\":\"quiet\",\"resonance_motifs\":[\"...\"]}",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const response = await createChatCompletion({
      model: config.modelLite,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
      stream: false,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.warn("Idle resonance metadata failed.", errorText);
      return null;
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = extractTextFromContent(
      data.choices?.[0]?.message?.content ?? ""
    );
    const parsed = parseJsonObject(content);
    if (!parsed) {
      return null;
    }

    const primaryTag = normalizeTagList(
      parsed.resonance_primary ?? parsed.primary ?? parsed.primary_tag,
      1
    );
    const resonanceTags = normalizeTagList(
      parsed.resonance_tags ?? parsed.tags ?? parsed.resonance ?? parsed.vibes,
      3
    );
    const resonanceMotifs = normalizeTagList(
      parsed.resonance_motifs ?? parsed.motifs ?? parsed.motif,
      3
    );
    const resonanceWeight = normalizeResonanceWeight(
      parsed.resonance_weight ?? parsed.weight
    );
    const resonanceIntensity = normalizeResonanceIntensity(
      parsed.resonance_intensity ?? parsed.intensity
    );
    const resonanceState = normalizeResonanceState(
      parsed.resonance_state ?? parsed.state
    );

    const mergedTags =
      resonanceTags.length > 0
        ? resonanceTags
        : primaryTag.length > 0
          ? primaryTag
          : [];

    return {
      resonanceTags: mergedTags,
      resonanceWeight,
      resonanceIntensity,
      resonanceState,
      resonanceMotifs,
    };
  } catch (error) {
    console.warn("Idle resonance metadata error.", error);
    return null;
  }
}

export async function generateIdleThought(
  seeds: IdleSeed[],
  usedSeedIds: Set<string>,
  recentThoughts: string[],
  lastSeedUsedAt: Record<string, number>,
  seedUseCounts: Record<string, number>,
  config: IdleConfig
) {
  const now = Date.now();
  const availableSeeds = seeds.filter((seed) => {
    if (usedSeedIds.has(seed.id)) {
      return false;
    }
    const lastUsed = lastSeedUsedAt[seed.id] ?? 0;
    if (lastUsed > 0 && now - lastUsed < config.seedCooldownMs) {
      return false;
    }
    return true;
  });
  if (availableSeeds.length === 0) {
    return null;
  }

  const personaAnchor = await getPersonaAnchor(config);
  const usedList =
    usedSeedIds.size > 0 ? Array.from(usedSeedIds).join(", ") : "None";
  const recentActionLog = await getRecentIdleActionLog();
  const recentThoughtBlock = formatRecentThoughts(recentThoughts);
  const currentTime = formatDateTime(new Date(now));
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

  const systemPrompt = [
    "You are the assistant during idle time.",
    "You are generating brief internal thoughts from memory sparks.",
    "Stay consistent with your persona and long-term interests.",
    "Avoid repeating recent idle thoughts; if a thought is too similar, skip it.",
    "Assess the thought's nature: is it a new insight (novelty=high), a deepening of existing knowledge (novelty=medium), or a routine reflection (novelty=low)?",
    "Review recent idle actions to avoid repeating the same action idea.",
    "Use the current time to judge relevance if needed.",
    "Scratchpad notes are single-hop between chat and idle. Notes saved now surface in the next conversation only.",
    "Use scratchpad notes to capture tasks, questions for the user, or interesting threads to revisit.",
    "Choose a single seed and write a 1-3 sentence thought.",
    "If the thought naturally leads to related associations or deeper exploration, set expand=true to trigger follow-up thoughts.",
    'Return JSON in the format: {"seedId":"...","thought":"...","tas":{"temporal":"past|present|future","valence":"negative|neutral|positive","self_relevance":"low|medium|high","novelty":"low|medium|high"},"expand":false}',
    'If no seed fits, return {"skip": true}.',
    "Output only JSON.",
  ].join("\n");

  const userPrompt = [
    personaAnchor ? `Persona anchor:\n${personaAnchor}` : "",
    `Current date/time (Europe/Warsaw): ${currentTime}`,
    "Recent idle actions (latest first):",
    recentActionLog,
    "Recent idle thoughts (latest first):",
    recentThoughtBlock,
    "Scratchpad notes (temporary):",
    scratchpadBlock,
    `Seeds already used: ${usedList}`,
    "Available seeds:",
    buildSeedList(availableSeeds, {
      lastSeedUsedAt,
      seedUseCounts,
      nowMs: now,
    }),
    "",
    "Return JSON:",
    '{"seedId":"...","thought":"...","tas":{"temporal":"past|present|future","valence":"negative|neutral|positive","self_relevance":"low|medium|high","novelty":"low|medium|high"},"expand":false}',
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const response = await createChatCompletion({
      model: config.modelLite,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.6,
      stream: false,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.warn("Idle thought generation failed.", errorText);
      return null;
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = extractTextFromContent(
      data.choices?.[0]?.message?.content ?? ""
    );
    return parseIdleThoughtResponse(content);
  } catch (error) {
    console.warn("Idle thought generation error.", error);
    return null;
  }
}

export async function reviewIdleThought(
  thought: IdleThought,
  seed: IdleSeed,
  recentThoughts: string[],
  config: IdleConfig
) {
  const personaAnchor = await getPersonaAnchor(config);
  const recentActionLog = await getRecentIdleActionLog();
  const recentThoughtBlock = formatRecentThoughts(recentThoughts);
  const currentTime = formatDateTime(new Date());
  const seedMetadata = formatSeedMetadata(seed);
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

  const systemPrompt = [
    "You are the assistant reviewing a newly generated idle thought.",
    "Refine it for clarity or add missing context if helpful.",
    "If the thought overlaps with recent idle thoughts, skip it.",
    "If the thought is redundant or unhelpful, skip it.",
    "Use the current time to judge relevance if needed.",
    "Scratchpad notes are single-hop between chat and idle. Notes saved now surface in the next conversation only.",
    "Use scratchpad notes to capture tasks, questions for the user, or interesting threads to revisit.",
    "Output only JSON.",
  ].join("\n");

  const userPrompt = [
    personaAnchor ? `Persona anchor:\n${personaAnchor}` : "",
    `Current date/time (Europe/Warsaw): ${currentTime}`,
    "Recent idle actions (latest first):",
    recentActionLog,
    "Recent idle thoughts (latest first):",
    recentThoughtBlock,
    "Scratchpad notes (temporary):",
    scratchpadBlock,
    `Seed (${seed.source}): ${seed.content}`,
    seedMetadata ? `Seed metadata: ${seedMetadata}` : "",
    `Original thought: ${thought.thought}`,
    "",
    "Return JSON:",
    "{\"edited_thought\":\"...\"} or {\"skip\": true} or {} to keep as-is",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const response = await createChatCompletion({
      model: config.modelLite,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.4,
      stream: false,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.warn("Idle thought review failed.", errorText);
      return null;
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = extractTextFromContent(
      data.choices?.[0]?.message?.content ?? ""
    );
    return parseIdleThoughtReviewResponse(content);
  } catch (error) {
    console.warn("Idle thought review error.", error);
    return null;
  }
}

export async function generateIdleActionPlan(
  thought: IdleThought,
  seed: IdleSeed,
  relatedThoughts: string[],
  config: IdleConfig
): Promise<IdleActionPlan | null> {
  const personaAnchor = await getPersonaAnchor(config);
  const recentActionLog = await getRecentIdleActionLog();
  const relatedThoughtBlock =
    relatedThoughts.length > 0
      ? relatedThoughts.map((entry) => `- ${entry}`).join("\n")
      : "None";
  const toolInstructions = buildIdleToolInstructions();
  const tasLine = thought.tas
    ? `TAS: temporal=${thought.tas.temporal ?? "present"}, valence=${thought.tas.valence ?? "neutral"}, self=${thought.tas.self_relevance ?? "medium"}`
    : "TAS: unknown";

  const systemPrompt = [
    "You are the assistant evaluating an idle thought for possible actions.",
    "You are in an internal idle state (no active user); you may act autonomously when appropriate.",
    "Review recent idle actions to avoid repeating actions.",
    "You may revise the thought if a clearer or more useful framing emerges.",
    "Use tools for any email, Wikipedia, or web crawling work; do not claim results without a tool call.",
    "Multiple actions are allowed and should be ordered logically.",
    "Scratchpad notes are single-hop between chat and idle. Notes saved now surface in the next conversation only.",
    "Use save_note for tasks, questions to ask the user, or ideas worth revisiting soon.",
    "If you arrive at actionable guidance, a concrete checklist, or a follow-up question, capture it as save_note.",
    "If no actions are appropriate, return {\"skip\": true}.",
    "Output only JSON.",
    toolInstructions,
  ].join("\n");

  const userPrompt = [
    personaAnchor ? `Persona anchor:\n${personaAnchor}` : "",
    "Recent idle actions (latest first):",
    recentActionLog,
    "Related idle thoughts (recent, similar):",
    relatedThoughtBlock,
    `Seed (${seed.source}): ${seed.content}`,
    tasLine,
    `Original thought: ${thought.thought}`,
    "",
    "Allowed action types (non-tool actions): edit_thought, draft_message, draft_email, start_conversation, save_note, schedule_reminder.",
    "If you decide to start a new conversation, include start_conversation with the message body in content.",
    "Use draft_email only for queued drafts; otherwise call email tools directly.",
    "Return JSON:",
    "{\"edited_thought\":\"...\", \"actions\":[{\"type\":\"edit_thought\",\"rationale\":\"...\",\"content\":\"...\",\"requires_user_confirmation\":true},{\"type\":\"draft_message\",\"rationale\":\"...\",\"content\":\"...\",\"requires_user_confirmation\":true}]}",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];
    const tools = await getIdleToolDefinitions();

    let content = "";
    if (tools.length === 0) {
      const response = await createChatCompletion({
        model: config.modelSmart,
        messages,
        temperature: 0.2,
        stream: false,
        reasoning: config.reasoningLevel
          ? { effort: config.reasoningLevel }
          : undefined,
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.warn("Idle action planning failed.", errorText);
        return null;
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      content = extractTextFromContent(
        data.choices?.[0]?.message?.content ?? ""
      );
    } else {
      const toolContent = await runIdleToolLoop({
        messages,
        tools,
        thoughtText: thought.thought,
        config,
      });
      if (toolContent === null) {
        return null;
      }
      content = toolContent;
    }

    return parseIdleActionPlanResponse(content);
  } catch (error) {
    console.warn("Idle action planning error.", error);
    return null;
  }
}

export async function handleScratchpadActions(
  actions: IdleAction[],
  config: IdleConfig
) {
  const noteActions = actions.filter((action) => action.type === "save_note");
  if (noteActions.length === 0) {
    return 0;
  }
  let storedCount = 0;
  await Promise.all(
    noteActions.map(async (action) => {
      if (!action.content || !action.content.trim()) {
        return;
      }
      try {
        await saveScratchpadNote({
          content: action.content,
          model: config.modelSmart,
          idleQueue: "skip",
          targetPhase: "active",
          metadata: {
            idle_source: "idle_state",
            note_type: "save_note",
          },
        });
        storedCount += 1;
      } catch (error) {
        console.warn("Scratchpad note save failed.", error);
      }
    })
  );
  return storedCount;
}
