import { extractTextFromContent } from "./chatContent";
import { createChatCompletion } from "./openrouter";
import type { WebArtifactRecord } from "./webArtifacts";

type ArtifactDecision = "use_artifact" | "recrawl" | "unknown";

export type ArtifactReuseDecision = {
  decision: ArtifactDecision;
  reason?: string;
  model?: string;
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

function summarizeToolArgs(args: Record<string, unknown>) {
  const summary: Record<string, unknown> = {};
  const keys = [
    "url",
    "query",
    "instruction",
    "prompt",
    "selector",
    "depth",
    "max_pages",
    "session_id",
  ];

  for (const key of keys) {
    if (!(key in args)) {
      continue;
    }
    const value = args[key];
    if (typeof value === "string") {
      summary[key] = truncateText(value, 220);
      continue;
    }
    if (
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      summary[key] = value;
    }
  }

  if (Object.keys(summary).length > 0) {
    return summary;
  }

  const fallback: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args).slice(0, 8)) {
    if (typeof value === "string") {
      fallback[key] = truncateText(value, 140);
    } else if (typeof value === "number" || typeof value === "boolean") {
      fallback[key] = value;
    }
  }
  return fallback;
}

function extractJsonObject(text: string) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    return null;
  }
  const slice = text.slice(start, end + 1);
  try {
    const parsed = JSON.parse(slice) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseDecisionFromText(text: string): ArtifactReuseDecision {
  const normalized = text.trim().toLowerCase();
  const parsed = extractJsonObject(text);

  const rawDecision =
    typeof parsed?.decision === "string"
      ? parsed.decision.trim().toLowerCase()
      : "";
  const reason =
    typeof parsed?.reason === "string"
      ? truncateText(parsed.reason, 180)
      : undefined;

  if (rawDecision === "use_artifact") {
    return { decision: "use_artifact", reason };
  }
  if (rawDecision === "recrawl") {
    return { decision: "recrawl", reason };
  }

  if (normalized.includes("use_artifact")) {
    return { decision: "use_artifact" };
  }
  if (normalized.includes("recrawl")) {
    return { decision: "recrawl" };
  }

  return { decision: "unknown" };
}

function resolveLiteModel(explicitModel?: string | null) {
  const direct = explicitModel?.trim();
  if (direct) {
    return direct;
  }
  const envModel = process.env.WEB_DECIDER_MODEL_LITE?.trim();
  if (envModel) {
    return envModel;
  }
  const idleModel = process.env.IDLE_MODEL_LITE?.trim();
  if (idleModel) {
    return idleModel;
  }
  return "google/gemini-2.5-flash-lite";
}

export async function decideArtifactReuse({
  userIntent,
  toolName,
  toolArgs,
  artifact,
  apiKey,
  appUrl,
  modelLite,
}: {
  userIntent?: string | null;
  toolName: string;
  toolArgs: Record<string, unknown>;
  artifact: WebArtifactRecord;
  apiKey?: string;
  appUrl?: string;
  modelLite?: string | null;
}): Promise<ArtifactReuseDecision> {
  const model = resolveLiteModel(modelLite);
  const intent = typeof userIntent === "string" ? userIntent.trim() : "";

  const artifactSummary = {
    id: artifact.id,
    domain: artifact.domain,
    url: artifact.url,
    title: artifact.title,
    snippet: artifact.snippet,
    source_tool: artifact.sourceTool,
    fetched_at: artifact.fetchedAt,
    ttl_seconds: artifact.ttlSeconds,
    digest_excerpt: artifact.contentDigest
      ? truncateText(artifact.contentDigest, 1200)
      : null,
  };

  const messages = [
    {
      role: "system" as const,
      content:
        "You decide whether a fresh cached web artifact is sufficient for the current user intent, or if the agent should recrawl. " +
        "Return JSON only: {\"decision\":\"use_artifact|recrawl\",\"reason\":\"short reason\"}. " +
        "Prefer use_artifact for follow-up questions on the same page/site unless user explicitly asks for latest/live/refresh or real-time updates.",
    },
    {
      role: "user" as const,
      content: [
        "User intent:",
        intent || "[not provided]",
        "",
        "Current tool call:",
        safeJsonStringify({
          tool_name: toolName,
          tool_args: summarizeToolArgs(toolArgs),
        }),
        "",
        "Fresh cached artifact:",
        safeJsonStringify(artifactSummary),
      ].join("\n"),
    },
  ];

  try {
    const response = await createChatCompletion({
      model,
      messages,
      temperature: 0,
      stream: false,
      apiKey,
      appUrl,
    });

    if (!response.ok) {
      return { decision: "unknown", model };
    }

    const data = await response.json();
    const text = extractTextFromContent(data?.choices?.[0]?.message?.content ?? "");
    const parsed = parseDecisionFromText(text);
    return {
      ...parsed,
      model,
    };
  } catch (error) {
    console.warn("Artifact advisor model decision failed.", error);
    return { decision: "unknown", model };
  }
}
