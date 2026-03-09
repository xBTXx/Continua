import { extractTextFromContent } from "./chatContent";
import { createChatCompletion } from "./openrouter";
import { listRecentWebArtifacts } from "./webArtifacts";
import { listRecentWebSessions } from "./webSessions";

type FollowupResolverResult = {
  args: Record<string, unknown>;
  metadata: {
    followup_context_hit: boolean;
    followup_artifact_id?: string;
    followup_reason?: string;
    decision_source?: string;
  };
};

type DecisionPayload = {
  should_apply?: boolean;
  selected_artifact_id?: string;
  resolved_url?: string;
  resolved_domain?: string;
  reason?: string;
};

function truncateText(value: string, maxLength: number) {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxLength - 3))}...`;
}

function safeJsonStringify(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

function pickLiteModel(explicitModel?: string | null) {
  const direct = explicitModel?.trim();
  if (direct) {
    return direct;
  }
  const envModel = process.env.WEB_DECIDER_MODEL_LITE?.trim();
  if (envModel) {
    return envModel;
  }
  const idleLite = process.env.IDLE_MODEL_LITE?.trim();
  if (idleLite) {
    return idleLite;
  }
  return "google/gemini-2.5-flash-lite";
}

function extractJsonObject(text: string): DecisionPayload | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    return null;
  }

  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as DecisionPayload;
  } catch {
    return null;
  }
}

function isTruthyApply(value: unknown) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "yes" || normalized === "apply";
}

function normalizeUrl(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function summarizeArgs(args: Record<string, unknown>) {
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key.toLowerCase().includes("password") || key.toLowerCase().includes("token")) {
      continue;
    }
    if (typeof value === "string") {
      summary[key] = truncateText(value, 180);
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean" || value === null) {
      summary[key] = value;
    }
  }
  return summary;
}

function buildPrompt({
  userIntent,
  toolName,
  args,
  artifacts,
  sessions,
}: {
  userIntent: string | null;
  toolName: string;
  args: Record<string, unknown>;
  artifacts: Array<Record<string, unknown>>;
  sessions: Array<Record<string, unknown>>;
}) {
  return [
    {
      role: "system" as const,
      content:
        "You decide follow-up browsing context for an autonomous agent. " +
        "Given recent artifacts/sessions and a new Crawl4AI tool call, decide if previous context should be applied. " +
        "Return JSON only with fields: " +
        "{\"should_apply\":boolean,\"selected_artifact_id\":string|null,\"resolved_url\":string|null,\"resolved_domain\":string|null,\"reason\":string}. " +
        "Do not force recrawl here; only decide context resolution.",
    },
    {
      role: "user" as const,
      content: [
        "User intent:",
        userIntent && userIntent.trim() ? truncateText(userIntent, 600) : "[not provided]",
        "",
        "Requested tool:",
        safeJsonStringify({ tool_name: toolName, tool_args: summarizeArgs(args) }),
        "",
        "Recent web artifacts:",
        safeJsonStringify(artifacts),
        "",
        "Recent web sessions:",
        safeJsonStringify(sessions),
      ].join("\n"),
    },
  ];
}

export async function resolveWebFollowupContext({
  conversationId,
  userIntent,
  toolName,
  args,
  apiKey,
  appUrl,
  modelLite,
}: {
  conversationId: string | null | undefined;
  userIntent?: string | null;
  toolName: string;
  args: Record<string, unknown>;
  apiKey?: string;
  appUrl?: string;
  modelLite?: string | null;
}): Promise<FollowupResolverResult> {
  const conversationKey =
    typeof conversationId === "string" ? conversationId.trim() : "";
  if (!conversationKey) {
    return {
      args,
      metadata: { followup_context_hit: false },
    };
  }

  const artifacts = await listRecentWebArtifacts({
    conversationId: conversationKey,
    limit: 10,
  });
  if (artifacts.length === 0) {
    return {
      args,
      metadata: { followup_context_hit: false },
    };
  }

  const sessions = await listRecentWebSessions({
    conversationId: conversationKey,
    limit: 8,
  });

  const model = pickLiteModel(modelLite);
  const artifactPreview = artifacts.map((artifact) => ({
    id: artifact.id,
    domain: artifact.domain,
    url: artifact.url,
    title: artifact.title,
    snippet: artifact.snippet ? truncateText(artifact.snippet, 140) : null,
    source_tool: artifact.sourceTool,
    fetched_at: artifact.fetchedAt,
  }));
  const sessionPreview = sessions.map((session) => ({
    domain: session.domain,
    session_id: session.crawl4aiSessionId,
    status: session.status,
    last_seen_at: session.lastSeenAt,
  }));

  try {
    const response = await createChatCompletion({
      model,
      messages: buildPrompt({
        userIntent: userIntent ?? null,
        toolName,
        args,
        artifacts: artifactPreview,
        sessions: sessionPreview,
      }),
      temperature: 0,
      stream: false,
      apiKey,
      appUrl,
    });

    if (!response.ok) {
      return {
        args,
        metadata: {
          followup_context_hit: false,
          decision_source: model,
        },
      };
    }

    const data = await response.json();
    const text = extractTextFromContent(data?.choices?.[0]?.message?.content ?? "");
    const parsed = extractJsonObject(text);

    if (!parsed || !isTruthyApply(parsed.should_apply)) {
      return {
        args,
        metadata: {
          followup_context_hit: false,
          followup_reason:
            typeof parsed?.reason === "string"
              ? truncateText(parsed.reason, 180)
              : undefined,
          decision_source: model,
        },
      };
    }

    const selectedById =
      typeof parsed.selected_artifact_id === "string"
        ? artifacts.find((artifact) => artifact.id === parsed.selected_artifact_id)
        : undefined;

    const resolvedUrl = normalizeUrl(parsed.resolved_url) || selectedById?.url || null;

    const nextArgs = { ...args };
    const hasUrl = typeof nextArgs.url === "string" && nextArgs.url.trim().length > 0;
    if (!hasUrl && resolvedUrl) {
      nextArgs.url = resolvedUrl;
    }

    if (
      toolName === "manage_session" &&
      (!nextArgs.initial_url ||
        (typeof nextArgs.initial_url === "string" && nextArgs.initial_url.trim().length === 0)) &&
      resolvedUrl
    ) {
      nextArgs.initial_url = resolvedUrl;
    }

    return {
      args: nextArgs,
      metadata: {
        followup_context_hit: Boolean(resolvedUrl),
        followup_artifact_id: selectedById?.id,
        followup_reason:
          typeof parsed.reason === "string"
            ? truncateText(parsed.reason, 180)
            : undefined,
        decision_source: model,
      },
    };
  } catch (error) {
    console.warn("Web follow-up resolver failed.", error);
    return {
      args,
      metadata: {
        followup_context_hit: false,
        decision_source: model,
      },
    };
  }
}
