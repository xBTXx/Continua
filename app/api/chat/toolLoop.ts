import { setLastToolDebug } from "@/app/api/tools/last/route";
import { extractTextFromContent } from "@/lib/chatContent";
import { createChatCompletion, ChatMessage, ToolDefinition } from "@/lib/openrouter";
import {
  PersonalMemoryContextMessage,
  savePersonalMemoryContext,
} from "@/lib/personalMemoryContext";
import { applyTokenGuard } from "@/lib/retrieval";
import { ToolCategory } from "@/lib/tooling";
import {
  MAX_TOOL_ROUNDS,
  PERSONAL_MEMORY_TOOL_SET,
  TOKEN_BUDGET,
} from "./constants";
import { resolveMessageIdFromHistory } from "./emailHelpers";
import { buildResponseHeaders, streamTextResponse } from "./responseHelpers";
import {
  extractLegacyToolCalls,
  extractToolCalls,
  parseToolArguments,
  stripLegacyToolMarkup,
} from "./toolParsing";
import { buildToolingBundle, insertToolSystemPrompt } from "./toolPrompts";
import { getMissingToolCategories, mergeToolCategories } from "./toolCategories";
import { logChatToolUse, runTool } from "./toolExecution";
import { prepareToolContextContent } from "./toolContext";
import { ChatPayload, ToolCall } from "./types";

const MAX_TOOL_ROUND_CONTEXT_LENGTH = parseEnvNumber(
  process.env.CHAT_TOOL_ROUND_CONTEXT_MAX_CHARS,
  24_000,
  4_000,
  120_000
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

type ExecutedToolTrace = {
  name: string;
  args: Record<string, unknown>;
};

type ChatCompletionData = {
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: unknown;
      [key: string]: unknown;
    } | null;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
};

function asExtractableToolContent(
  value: unknown
): string | Record<string, unknown> | Array<Record<string, unknown>> {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === "object" && entry !== null && !Array.isArray(entry)
    );
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return "";
}

function extractPrimaryChoiceText(data: ChatCompletionData | null): string {
  return extractTextFromContent(
    asExtractableToolContent(data?.choices?.[0]?.message?.content)
  );
}

function readWebMeta(result: unknown) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return null;
  }
  const meta = (result as Record<string, unknown>)._assistant_web;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return null;
  }
  return meta as Record<string, unknown>;
}

function buildWebMetaPrefix(result: unknown) {
  const meta = readWebMeta(result);
  if (!meta) {
    return null;
  }

  const parts: string[] = [];
  const domain =
    typeof meta.web_domain === "string"
      ? meta.web_domain
      : typeof meta.domain === "string"
        ? meta.domain
        : null;
  if (domain) {
    parts.push(`domain=${domain}`);
  }

  if (meta.session_reuse_hit === true || meta.session_reused === true) {
    parts.push("session_reuse_hit=true");
  }

  if (typeof meta.session_id_used === "string") {
    parts.push(`session_id_used=${meta.session_id_used}`);
  } else if (typeof meta.session_id === "string") {
    parts.push(`session_id=${meta.session_id}`);
  }

  if (typeof meta.artifact_id_saved === "string") {
    parts.push(`artifact_id_saved=${meta.artifact_id_saved}`);
  }

  if (meta.artifact_fresh_hit === true) {
    parts.push("artifact_fresh_hit=true");
  }

  if (typeof meta.decision_source === "string") {
    parts.push(`decision_source=${meta.decision_source}`);
  }

  if (meta.followup_context_hit === true) {
    parts.push("followup_context_hit=true");
  }

  if (typeof meta.followup_artifact_id === "string") {
    parts.push(`followup_artifact_id=${meta.followup_artifact_id}`);
  }

  if (typeof meta.followup_reason === "string" && meta.followup_reason.trim()) {
    parts.push(`followup_reason=${meta.followup_reason.trim()}`);
  }

  if (typeof meta.fallback_reason === "string") {
    parts.push(`fallback_reason=${meta.fallback_reason}`);
  }

  return parts.length > 0 ? `Web tool metadata: ${parts.join(" ")}` : null;
}

const FINAL_SUMMARY_PROMPT =
  "Tools have already been executed. Provide a user-facing summary of what you found and what happened next. Do not call tools. Do not return an empty response.";

function summarizeToolArgs(args: Record<string, unknown>) {
  const prioritizedKeys = [
    "url",
    "query",
    "path",
    "action",
    "session_id",
    "message_id",
  ] as const;
  for (const key of prioritizedKeys) {
    const value = args[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return `${key}=${value.trim()}`;
    }
  }
  return "";
}

function buildNoSummaryFallback({
  executedToolTrace,
  pendingToolCalls,
  finalData,
}: {
  executedToolTrace: ExecutedToolTrace[];
  pendingToolCalls: ToolCall[];
  finalData: ChatCompletionData | null;
}) {
  const executedCount = executedToolTrace.length;
  const recentExecuted = executedToolTrace
    .slice(-4)
    .map((entry) => {
      const details = summarizeToolArgs(entry.args);
      return details ? `${entry.name} (${details})` : entry.name;
    })
    .join(", ");
  const pendingNames = pendingToolCalls.map((call) => call.function.name).join(", ");
  const finishReason =
    typeof finalData?.choices?.[0]?.finish_reason === "string"
      ? finalData.choices[0].finish_reason
      : null;

  const lines = [
    `I executed ${executedCount} tool call${executedCount === 1 ? "" : "s"}${
      recentExecuted ? ` (${recentExecuted})` : ""
    }, but no final summary text was returned.`,
  ];
  if (pendingNames) {
    lines.push(
      `The model kept requesting additional tool calls (${pendingNames}) and likely hit the tool round limit (${MAX_TOOL_ROUNDS}).`
    );
  } else {
    lines.push("The model returned an empty assistant message after tool execution.");
  }
  if (finishReason) {
    lines.push(`Last finish reason: ${finishReason}.`);
  }
  return lines.join(" ");
}

function summarizeFinalMessageForLog(finalData: ChatCompletionData | null) {
  if (!finalData) {
    return {
      finishReason: null,
      contentType: "null",
      messageKeys: [],
      contentPreview: null,
    };
  }
  const choice = finalData?.choices?.[0];
  const message = choice?.message;
  const content = message?.content;
  const contentType = Array.isArray(content)
    ? "array"
    : content === null
      ? "null"
      : typeof content;
  const messageKeys =
    message && typeof message === "object" ? Object.keys(message) : [];
  const finishReason =
    typeof choice?.finish_reason === "string" ? choice.finish_reason : null;

  let contentPreview: string | null = null;
  if (typeof content === "string") {
    contentPreview = content.slice(0, 200);
  } else if (Array.isArray(content)) {
    contentPreview = JSON.stringify(content.slice(0, 2)).slice(0, 200);
  } else if (content && typeof content === "object") {
    contentPreview = JSON.stringify(content).slice(0, 200);
  }

  return {
    finishReason,
    contentType,
    messageKeys,
    contentPreview,
  };
}

function extractLatestUserIntent(messages: ChatMessage[]) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "user") {
      continue;
    }
    const text = extractTextFromContent(message.content ?? "").trim();
    if (text.length > 0) {
      return text;
    }
  }
  return null;
}

async function requestFinalSummaryPass({
  payload,
  toolMessages,
  activeTools,
  webPlugins,
  forcedPrompt,
}: {
  payload: ChatPayload;
  toolMessages: ChatMessage[];
  activeTools: ToolDefinition[];
  webPlugins?: Array<{ id: string }>;
  forcedPrompt?: string;
}) {
  const messages = forcedPrompt
    ? [
        ...toolMessages,
        {
          role: "system" as const,
          content: forcedPrompt,
        },
      ]
    : toolMessages;

  const response = await createChatCompletion({
    model: payload.model!,
    messages,
    temperature: payload.temperature,
    stream: false,
    reasoning: payload.reasoning,
    plugins: webPlugins,
    tools: activeTools,
    tool_choice: "none",
    apiKey: payload.apiKey,
    appUrl: payload.appUrl,
  });

  if (!response.ok) {
    return null;
  }

  const data = await response.json();
  const content = extractTextFromContent(data?.choices?.[0]?.message?.content ?? "");
  return { data, content };
}

export async function runChatWithTools({
  payload,
  preparedMessages,
  baseMessages,
  tools,
  toolNameSet,
  selectedToolCategories,
  ssefSelectionQuery,
  conversationId,
  personalMemoryContext,
  webPlugins,
  injectionId,
}: {
  payload: ChatPayload;
  preparedMessages: ChatMessage[];
  baseMessages: ChatMessage[];
  tools: ToolDefinition[];
  toolNameSet: Set<string>;
  selectedToolCategories: ToolCategory[];
  ssefSelectionQuery: string;
  conversationId: string | null;
  personalMemoryContext: PersonalMemoryContextMessage[];
  webPlugins?: Array<{ id: string }>;
  injectionId: string | null;
}): Promise<Response> {
  if (tools.length === 0) {
    const response = await createChatCompletion({
      model: payload.model!,
      messages: preparedMessages,
      temperature: payload.temperature,
      stream: payload.stream,
      reasoning: payload.reasoning,
      plugins: webPlugins,
      apiKey: payload.apiKey,
      appUrl: payload.appUrl,
    });

    if (!response.ok) {
      const errorText = await response.text();
      return new Response(errorText, { status: response.status });
    }

    if (payload.stream) {
      return new Response(response.body, {
        status: response.status,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
        },
      });
    }

    const data = await response.json();
    return Response.json(data);
  }

  let toolMessages = [...preparedMessages];
  let finalData: ChatCompletionData | null = null;
  let pendingToolCalls: ToolCall[] = [];
  let lastToolError: string | null = null;
  let toolErrorAttempts = 0;
  let personalMemoryUsed = false;
  let toolExpansionAttempts = 0;
  const activeToolCategorySet = new Set(selectedToolCategories);
  let activeSelectedToolCategories = [...selectedToolCategories];
  let activeTools = tools;
  let activeToolNameSet = toolNameSet;
  const executedToolTrace: ExecutedToolTrace[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const response = await createChatCompletion({
      model: payload.model!,
      messages: toolMessages,
      temperature: payload.temperature,
      stream: false,
      reasoning: payload.reasoning,
      plugins: webPlugins,
      tools: activeTools,
      tool_choice: "auto",
      parallel_tool_calls: false,
      apiKey: payload.apiKey,
      appUrl: payload.appUrl,
    });

    if (!response.ok) {
      const errorText = await response.text();
      return new Response(errorText, { status: response.status });
    }

    const data = await response.json();
    finalData = data;
    const assistantMessage = data?.choices?.[0]?.message;
    let toolCalls = extractToolCalls(data);
    let assistantContent = extractTextFromContent(assistantMessage?.content ?? "");
    if (toolCalls.length === 0) {
      toolCalls = extractLegacyToolCalls(assistantContent);
      if (toolCalls.length > 0) {
        assistantContent = stripLegacyToolMarkup(assistantContent);
      }
    }

    if (toolCalls.length > 0 && round === 0 && toolExpansionAttempts < 1) {
      const missingCategories = await getMissingToolCategories(
        toolCalls,
        activeToolNameSet
      );
      if (missingCategories.length > 0) {
        toolExpansionAttempts += 1;
        missingCategories.forEach((category) => {
          activeToolCategorySet.add(category);
        });
        activeSelectedToolCategories = mergeToolCategories(
          activeSelectedToolCategories,
          missingCategories
        );
        const toolingBundle = await buildToolingBundle(activeToolCategorySet, {
          ssefSelectionQuery,
        });
        preparedMessages = insertToolSystemPrompt(
          baseMessages,
          toolingBundle.toolFlags,
          toolingBundle.toolCatalogLines
        );
        preparedMessages = applyTokenGuard(preparedMessages, TOKEN_BUDGET);
        activeTools = toolingBundle.tools;
        activeToolNameSet = toolingBundle.toolNameSet;
        toolMessages = [...preparedMessages];
        pendingToolCalls = [];
        lastToolError = null;
        toolErrorAttempts = 0;
        personalMemoryUsed = false;
        round = -1;
        continue;
      }
    }

    pendingToolCalls = toolCalls;
    if (toolCalls.length === 0) {
      pendingToolCalls = [];
      break;
    }

    const firstPersonalMemoryIndex = personalMemoryUsed
      ? -1
      : toolCalls.findIndex((call) =>
          PERSONAL_MEMORY_TOOL_SET.has(call.function.name)
        );
    const parsedToolArgs = toolCalls.map((call) =>
      parseToolArguments(call.function.arguments)
    );

    const latestUserIntent = extractLatestUserIntent(toolMessages);
    const toolResults = await Promise.all(
      toolCalls.map(async (call, index) => {
        const args = parsedToolArgs[index];
        if (call.function.name === "get_message" || call.function.name === "reply") {
          const resolved = resolveMessageIdFromHistory(args, toolMessages);
          if (resolved) {
            args.message_id = resolved;
          }
        }

        const isPersonalMemoryTool = PERSONAL_MEMORY_TOOL_SET.has(
          call.function.name
        );
        if (
          isPersonalMemoryTool &&
          (personalMemoryUsed || index !== firstPersonalMemoryIndex)
        ) {
          return { status: "skipped", reason: "limit_reached" };
        }

        try {
          if (isPersonalMemoryTool) {
            personalMemoryUsed = true;
          }
          const result = await runTool(call.function.name, args, {
            apiKey: payload.apiKey,
            appUrl: payload.appUrl,
            model: payload.model,
            modelLite: process.env.IDLE_MODEL_LITE ?? undefined,
            conversationId,
            userIntent: latestUserIntent,
          });

          if (result && typeof result === "object" && !("error" in result)) {
            void logChatToolUse(call.function.name, args, result, payload.model);
          }

          return result;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Tool execution failed.";
          console.warn("Tool execution failed.", message);
          if (isPersonalMemoryTool) {
            return { status: "skipped", reason: "error", message };
          }
          return { error: message };
        }
      })
    );
    toolResults.forEach((result, index) => {
      if (!result || typeof result !== "object") {
        return;
      }
      if ("error" in result) {
        return;
      }
      if ("status" in result && (result as { status?: unknown }).status === "skipped") {
        return;
      }
      executedToolTrace.push({
        name: toolCalls[index].function.name,
        args: parsedToolArgs[index],
      });
    });

    if (personalMemoryContext.length > 0) {
      const contextWrites = toolResults
        .map((result, index) => {
          const call = toolCalls[index];
          if (!PERSONAL_MEMORY_TOOL_SET.has(call.function.name)) {
            return null;
          }
          const memoryId =
            result && typeof result === "object" && "id" in result
              ? (result as { id?: unknown }).id
              : null;
          if (typeof memoryId !== "string" || memoryId.trim().length === 0) {
            return null;
          }
          return savePersonalMemoryContext({
            personalMemoryId: memoryId,
            conversationId,
            messages: personalMemoryContext,
          });
        })
        .filter((entry) => entry !== null) as Promise<unknown>[];

      if (contextWrites.length > 0) {
        try {
          await Promise.all(contextWrites);
        } catch (error) {
          console.warn("Failed to store personal memory context.", error);
        }
      }
    }

    if (payload.debugTools) {
      setLastToolDebug({
        toolCalls,
        toolResults,
        assistantMessage: {
          content: extractTextFromContent(assistantMessage?.content ?? ""),
          reasoning: assistantMessage?.reasoning ?? null,
          reasoning_details: assistantMessage?.reasoning_details ?? null,
        },
      });
    }

    const perToolContextLength = Math.floor(
      MAX_TOOL_ROUND_CONTEXT_LENGTH / Math.max(1, toolCalls.length)
    );
    const toolResponseMessages: ChatMessage[] = toolCalls.map((call, index) => {
      const result = toolResults[index];
      const preparedContext = prepareToolContextContent(
        result,
        perToolContextLength
      );
      const webMetaPrefix = buildWebMetaPrefix(result);
      return {
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: webMetaPrefix
          ? `${webMetaPrefix}\n${preparedContext}`.trim()
          : preparedContext,
      };
    });

    const toolErrors = toolResults
      .map((result, index) => ({ result, call: toolCalls[index] }))
      .filter(
        (entry) =>
          entry.result &&
          typeof entry.result === "object" &&
          "error" in entry.result
      ) as Array<{ result: { error: string }; call: ToolCall }>;

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
      const shouldRetry = toolErrorAttempts <= 1 && errorSummary !== lastToolError;
      if (shouldRetry) {
        lastToolError = errorSummary;
        toolMessages = nextToolMessages;
        continue;
      }
      const content = `Tool error: ${errorSummary}`;
      const responseHeaders = buildResponseHeaders(personalMemoryUsed, injectionId);
      if (payload.stream) {
        return streamTextResponse(content, responseHeaders);
      }
      return Response.json(
        {
          choices: [{ message: { content } }],
        },
        { headers: responseHeaders }
      );
    }

    toolMessages = nextToolMessages;
  }

  if (pendingToolCalls.length > 0) {
    const response = await createChatCompletion({
      model: payload.model!,
      messages: toolMessages,
      temperature: payload.temperature,
      stream: false,
      reasoning: payload.reasoning,
      plugins: webPlugins,
      tools: activeTools,
      tool_choice: "none",
      apiKey: payload.apiKey,
      appUrl: payload.appUrl,
    });

    if (!response.ok) {
      const errorText = await response.text();
      return new Response(errorText, { status: response.status });
    }

    finalData = await response.json();
  }

  if (!finalData) {
    throw new Error("Tool execution did not return a response.");
  }

  if (payload.stream) {
    let content = extractPrimaryChoiceText(finalData);
    if (!content.trim()) {
      const retry = await requestFinalSummaryPass({
        payload,
        toolMessages,
        activeTools,
        webPlugins,
      });
      if (retry) {
        content = retry.content;
        finalData = retry.data;
      }
    }
    if (!content.trim()) {
      const forcedRetry = await requestFinalSummaryPass({
        payload,
        toolMessages,
        activeTools,
        webPlugins,
        forcedPrompt: FINAL_SUMMARY_PROMPT,
      });
      if (forcedRetry) {
        content = forcedRetry.content;
        finalData = forcedRetry.data;
      }
    }
    if (!content.trim()) {
      content = buildNoSummaryFallback({
        executedToolTrace,
        pendingToolCalls,
        finalData,
      });
      console.warn("Tool loop ended without assistant summary.", {
        model: payload.model,
        executedTools: executedToolTrace.length,
        pendingTools: pendingToolCalls.map((call) => call.function.name),
        ...summarizeFinalMessageForLog(finalData),
      });
    }
    const responseHeaders = buildResponseHeaders(personalMemoryUsed, injectionId);
    return streamTextResponse(content, responseHeaders);
  }

  let finalContent = extractPrimaryChoiceText(finalData);
  if (!finalContent.trim()) {
    const retry = await requestFinalSummaryPass({
      payload,
      toolMessages,
      activeTools,
      webPlugins,
    });
    if (retry) {
      finalData = retry.data;
      finalContent = retry.content;
    }
  }
  if (!finalContent.trim()) {
    const forcedRetry = await requestFinalSummaryPass({
      payload,
      toolMessages,
      activeTools,
      webPlugins,
      forcedPrompt: FINAL_SUMMARY_PROMPT,
    });
    if (forcedRetry) {
      finalData = forcedRetry.data;
      finalContent = forcedRetry.content;
    }
  }
  if (!finalContent.trim()) {
    const content = buildNoSummaryFallback({
      executedToolTrace,
      pendingToolCalls,
      finalData,
    });
    console.warn("Tool loop ended without assistant summary.", {
      model: payload.model,
      executedTools: executedToolTrace.length,
      pendingTools: pendingToolCalls.map((call) => call.function.name),
      ...summarizeFinalMessageForLog(finalData),
    });
    finalData = {
      choices: [{ message: { role: "assistant", content } }],
    };
  }

  const responseHeaders = buildResponseHeaders(personalMemoryUsed, injectionId);
  return Response.json(finalData, { headers: responseHeaders });
}
