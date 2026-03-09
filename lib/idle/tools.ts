import { createChatCompletion, ChatMessage, ToolDefinition } from "../openrouter";
import { extractTextFromContent } from "../chatContent";
import {
  runIdleTool,
  buildEmailActionContent,
  LOGGED_EMAIL_TOOLS,
} from "../idleTooling";
import { saveIdleActionLogEntries, IdleAction } from "../idleActions";
import { MAX_IDLE_TOOL_ROUNDS } from "./constants";
import { IdleConfig, IdleToolCall } from "./types";
import {
  extractToolCalls,
  extractLegacyToolCalls,
  stripLegacyToolMarkup,
  parseToolArguments,
  resolveMessageIdFromHistory,
  truncateText,
} from "./utils";

const MAX_IDLE_TOOL_CONTEXT_CHARS = parseEnvNumber(
  process.env.IDLE_TOOL_CONTEXT_MAX_CHARS,
  8_000,
  1_000,
  40_000
);
const MAX_IDLE_TOOL_ROUND_CONTEXT_CHARS = parseEnvNumber(
  process.env.IDLE_TOOL_ROUND_CONTEXT_MAX_CHARS,
  20_000,
  4_000,
  100_000
);
const MIN_IDLE_TOOL_CONTEXT_CHARS = parseEnvNumber(
  process.env.IDLE_TOOL_CONTEXT_MIN_CHARS,
  1_500,
  500,
  MAX_IDLE_TOOL_CONTEXT_CHARS
);

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

function prepareIdleToolContext(result: unknown, preferredLength?: number) {
  const maxLength =
    typeof preferredLength === "number" && Number.isFinite(preferredLength)
      ? Math.min(
          MAX_IDLE_TOOL_CONTEXT_CHARS,
          Math.max(MIN_IDLE_TOOL_CONTEXT_CHARS, Math.floor(preferredLength))
        )
      : MAX_IDLE_TOOL_CONTEXT_CHARS;

  if (result === null || typeof result === "undefined") {
    return "";
  }
  if (typeof result === "string") {
    return truncateText(result, maxLength);
  }
  try {
    return truncateText(JSON.stringify(result), maxLength);
  } catch {
    return "[tool result is not serializable]";
  }
}

export async function runIdleToolLoop({
  messages,
  tools,
  thoughtText,
  config,
}: {
  messages: ChatMessage[];
  tools: ToolDefinition[];
  thoughtText: string;
  config: IdleConfig;
}) {
  let toolMessages = [...messages];
  let pendingToolCalls: IdleToolCall[] = [];
  let lastToolError: string | null = null;
  let toolErrorAttempts = 0;
  let finalContent = "";
  let needsFinalCompletion = false;

  for (let round = 0; round < MAX_IDLE_TOOL_ROUNDS; round += 1) {
    const response = await createChatCompletion({
      model: config.modelSmart,
      messages: toolMessages,
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
      console.warn("Idle tool loop failed.", errorText);
      return null;
    }

    const data = await response.json();
    const assistantMessage = data?.choices?.[0]?.message;
    let toolCalls = extractToolCalls(data);
    let assistantContent = extractTextFromContent(assistantMessage?.content ?? "");
    if (toolCalls.length === 0) {
      toolCalls = extractLegacyToolCalls(assistantContent);
      if (toolCalls.length > 0) {
        assistantContent = stripLegacyToolMarkup(assistantContent);
      }
    }
    pendingToolCalls = toolCalls;
    if (toolCalls.length === 0) {
      finalContent = assistantContent;
      break;
    }

    const toolResults = await Promise.all(
      toolCalls.map(async (call) => {
        const args = parseToolArguments(call.function.arguments);
        if (call.function.name === "get_message" || call.function.name === "reply") {
          const resolved = resolveMessageIdFromHistory(args, toolMessages);
          if (resolved) {
            args.message_id = resolved;
          }
        }

        try {
          const result = await runIdleTool(call.function.name, args);
          return { call, args, result };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Tool execution failed.";
          console.warn("Idle tool execution failed.", message);
          return { call, args, result: { error: message } };
        }
      })
    );

    const logActions: IdleAction[] = toolResults
      .filter(
        (entry) =>
          LOGGED_EMAIL_TOOLS.has(entry.call.function.name) &&
          entry.result &&
          typeof entry.result === "object" &&
          !("error" in entry.result)
      )
      .map((entry) => ({
        type: entry.call.function.name,
        content: buildEmailActionContent(entry.call.function.name, entry.args),
      }));

    if (logActions.length > 0) {
      try {
        await saveIdleActionLogEntries({
          thoughtText,
          actions: logActions,
          model: config.modelSmart,
          source: "executed",
        });
      } catch (error) {
        console.warn("Idle tool action log failed.", error);
      }
    }

    const perToolContextLength = Math.floor(
      MAX_IDLE_TOOL_ROUND_CONTEXT_CHARS / Math.max(1, toolResults.length)
    );
    const toolResponseMessages: ChatMessage[] = toolResults.map((entry) => ({
      role: "tool",
      tool_call_id: entry.call.id,
      name: entry.call.function.name,
      content: prepareIdleToolContext(entry.result, perToolContextLength),
    }));

    const toolErrors = toolResults.filter(
      (entry) =>
        entry.result &&
        typeof entry.result === "object" &&
        "error" in entry.result
    ) as Array<{ call: IdleToolCall; result: { error: string } }>;

    const nextToolMessages: ChatMessage[] = [
      ...toolMessages,
      {
        role: "assistant",
        content: assistantContent,
        tool_calls: toolCalls,
        reasoning: assistantMessage?.reasoning,
        reasoning_details: assistantMessage?.reasoning_details,
      },
      ...toolResponseMessages,
    ];

    if (toolErrors.length > 0) {
      const errorSummary = toolErrors
        .map((entry) => `${entry.call.function.name}: ${entry.result.error}`)
        .join(" | ");
      toolErrorAttempts += 1;
      const shouldRetry =
        toolErrorAttempts <= 1 && errorSummary !== lastToolError;
      if (shouldRetry) {
        lastToolError = errorSummary;
        toolMessages = nextToolMessages;
        continue;
      }
      needsFinalCompletion = true;
      toolMessages = nextToolMessages;
      break;
    }

    toolMessages = nextToolMessages;
  }

  if (pendingToolCalls.length > 0) {
    needsFinalCompletion = true;
  }

  if (needsFinalCompletion || !finalContent.trim()) {
    const response = await createChatCompletion({
      model: config.modelSmart,
      messages: toolMessages,
      temperature: 0.2,
      stream: false,
      reasoning: config.reasoningLevel
        ? { effort: config.reasoningLevel }
        : undefined,
      tools,
      tool_choice: "none",
      parallel_tool_calls: false,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.warn("Idle tool finalization failed.", errorText);
      return finalContent || null;
    }

    const data = await response.json();
    finalContent = extractTextFromContent(
      data?.choices?.[0]?.message?.content ?? finalContent
    );
  }

  return finalContent;
}
