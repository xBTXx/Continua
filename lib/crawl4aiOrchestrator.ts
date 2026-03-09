import { runCrawl4AITool } from "./crawl4aiTools";
import {
  getActiveWebSession,
  markWebSessionStatus,
  resolveDomainFromToolCall,
  upsertWebSession,
} from "./webSessions";
import {
  getFreshWebArtifactForToolCall,
  saveWebArtifactFromToolResult,
} from "./webArtifacts";
import { decideArtifactReuse } from "./webArtifactAdvisor";
import { resolveWebFollowupContext } from "./webFollowupResolver";

type Crawl4AISessionMeta = {
  source: "chat" | "idle";
  web_domain: string | null;
  session_id_used?: string;
  session_id_created?: string;
  session_reuse_hit?: boolean;
  retry_without_session?: boolean;
  artifact_id_saved?: string;
  artifact_fresh_hit?: boolean;
  followup_context_hit?: boolean;
  followup_artifact_id?: string;
  followup_reason?: string;
  decision_source?: string;
  fallback_reason?: string;
  // Backward-compatible aliases.
  domain: string | null;
  session_id?: string;
  session_reused?: boolean;
};

type Crawl4AIResult = Record<string, unknown>;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function readSessionIdFromArgs(args: Record<string, unknown>) {
  const sessionId = args.session_id;
  if (!isNonEmptyString(sessionId)) {
    return null;
  }
  return sessionId.trim();
}

function extractSessionIdFromText(text: string) {
  const patterns = [
    /Session ID:\s*([A-Za-z0-9._:-]+)/i,
    /session[_ ]id["'\s:=]+([A-Za-z0-9._:-]+)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return null;
}

function extractSessionIdFromResult(result: unknown) {
  if (!result || typeof result !== "object") {
    return null;
  }
  const record = result as Record<string, unknown>;
  if (isNonEmptyString(record.session_id)) {
    return record.session_id.trim();
  }
  if (isNonEmptyString(record.sessionId)) {
    return record.sessionId.trim();
  }
  const content = Array.isArray(record.content) ? record.content : [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const text = (item as { text?: unknown }).text;
    if (!isNonEmptyString(text)) {
      continue;
    }
    const found = extractSessionIdFromText(text);
    if (found) {
      return found;
    }
  }
  return null;
}

function isSessionErrorMessage(message: string) {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("session") ||
    normalized.includes("target closed") ||
    normalized.includes("context closed") ||
    normalized.includes("browser has been closed")
  );
}

function withMetadata(result: unknown, metadata: Crawl4AISessionMeta) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return result;
  }
  const record = result as Crawl4AIResult;
  return { ...record, _assistant_web: metadata };
}

export async function runCrawl4AIToolOrchestrated({
  name,
  args,
  conversationId,
  source = "chat",
  userIntent,
  apiKey,
  appUrl,
  modelLite,
}: {
  name: string;
  args: Record<string, unknown>;
  conversationId?: string | null;
  source?: "chat" | "idle";
  userIntent?: string | null;
  apiKey?: string;
  appUrl?: string;
  modelLite?: string | null;
}) {
  let callArgs = { ...(args ?? {}) };
  let reusedSessionId: string | null = null;
  let retriedWithoutSession = false;
  let createdSessionId: string | null = null;
  let fallbackReason: string | undefined;
  let decisionSource: string | undefined;
  let followupContextHit = false;
  let followupArtifactId: string | undefined;
  let followupReason: string | undefined;

  if (conversationId) {
    try {
      const followupResolution = await resolveWebFollowupContext({
        conversationId,
        userIntent: userIntent ?? null,
        toolName: name,
        args: callArgs,
        apiKey,
        appUrl,
        modelLite,
      });
      callArgs = { ...followupResolution.args };
      followupContextHit = followupResolution.metadata.followup_context_hit;
      followupArtifactId = followupResolution.metadata.followup_artifact_id;
      followupReason = followupResolution.metadata.followup_reason;
      if (followupResolution.metadata.decision_source) {
        decisionSource = followupResolution.metadata.decision_source;
      }
    } catch (error) {
      console.warn("Follow-up context resolver failed.", error);
    }
  }

  const domain = resolveDomainFromToolCall(name, callArgs);
  const explicitSessionId = readSessionIdFromArgs(callArgs);

  if (name === "crawl" && !explicitSessionId && conversationId && domain) {
    try {
      const existing = await getActiveWebSession({ conversationId, domain });
      if (existing?.crawl4aiSessionId) {
        reusedSessionId = existing.crawl4aiSessionId;
        callArgs.session_id = existing.crawl4aiSessionId;
      }
    } catch (error) {
      console.warn("Web session lookup failed.", error);
    }
  }

  if (name === "crawl" && conversationId && domain) {
    try {
      const targetUrl =
        typeof callArgs.url === "string" ? callArgs.url.trim() : null;
      const freshArtifact = await getFreshWebArtifactForToolCall({
        conversationId,
        domain,
        url: targetUrl,
      });

      if (freshArtifact) {
        const advisor = await decideArtifactReuse({
          userIntent: userIntent ?? null,
          toolName: name,
          toolArgs: callArgs,
          artifact: freshArtifact,
          apiKey,
          appUrl,
          modelLite,
        });
        decisionSource = advisor.model ?? "lite_model";
        if (advisor.decision === "use_artifact") {
          const artifactSummary = [
            `Reused fresh web artifact ${freshArtifact.id} instead of recrawling.`,
            `Fetched at: ${new Date(freshArtifact.fetchedAt).toISOString()}.`,
            `URL: ${freshArtifact.url}.`,
            freshArtifact.title ? `Title: ${freshArtifact.title}.` : "",
            freshArtifact.snippet ? `Snippet: ${freshArtifact.snippet}.` : "",
            freshArtifact.contentDigest
              ? `Digest:\n${freshArtifact.contentDigest}`
              : "",
          ]
            .filter(Boolean)
            .join("\n");

          const artifactResult = {
            content: [{ type: "text", text: artifactSummary }],
            artifact: {
              id: freshArtifact.id,
              domain: freshArtifact.domain,
              url: freshArtifact.url,
              title: freshArtifact.title,
              snippet: freshArtifact.snippet,
              fetched_at: freshArtifact.fetchedAt,
              source_tool: freshArtifact.sourceTool,
            },
          };

          return withMetadata(artifactResult, {
            source,
            web_domain: domain,
            session_id_used: readSessionIdFromArgs(callArgs) ?? undefined,
            session_reuse_hit: Boolean(reusedSessionId),
            artifact_id_saved: freshArtifact.id,
            artifact_fresh_hit: true,
            followup_context_hit: followupContextHit,
            followup_artifact_id: followupArtifactId,
            followup_reason: followupReason,
            decision_source: decisionSource,
            fallback_reason: "artifact_shortcut",
            domain,
            session_id: readSessionIdFromArgs(callArgs) ?? undefined,
            session_reused: Boolean(reusedSessionId),
          });
        }
      }
    } catch (error) {
      console.warn("Artifact freshness shortcut evaluation failed.", error);
    }
  }

  const execute = async (currentArgs: Record<string, unknown>) =>
    runCrawl4AITool(name, currentArgs);

  let result: unknown;
  let executedArgs = callArgs;
  try {
    result = await execute(callArgs);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Crawl4AI tool execution failed.";
    const canRetry =
      name === "crawl" &&
      Boolean(reusedSessionId) &&
      isSessionErrorMessage(message);
    if (!canRetry) {
      throw error;
    }

    retriedWithoutSession = true;
    fallbackReason = "session_invalid_retry";
    try {
      await markWebSessionStatus({
        crawl4aiSessionId: reusedSessionId,
        status: "stale",
        conversationId: conversationId ?? null,
        domain,
      });
    } catch (statusError) {
      console.warn("Failed to mark stale web session.", statusError);
    }

    const retryArgs = { ...(args ?? {}) };
    executedArgs = retryArgs;
    result = await execute(retryArgs);
  }

  const activeSessionId = readSessionIdFromArgs(executedArgs);

  if (name === "crawl" && conversationId && domain && activeSessionId) {
    try {
      await upsertWebSession({
        conversationId,
        domain,
        crawl4aiSessionId: activeSessionId,
        status: "active",
        meta: {
          source,
          reused: Boolean(reusedSessionId),
        },
      });
    } catch (error) {
      console.warn("Web session upsert failed after crawl.", error);
    }
  }

  if (name === "manage_session") {
    const action = isNonEmptyString(callArgs.action)
      ? callArgs.action.trim().toLowerCase()
      : "";

    if (action === "create" && conversationId && domain) {
      const createdSession =
        readSessionIdFromArgs(callArgs) || extractSessionIdFromResult(result);
      if (createdSession) {
        createdSessionId = createdSession;
        try {
          await upsertWebSession({
            conversationId,
            domain,
            crawl4aiSessionId: createdSession,
            status: "active",
            meta: { source, created_via: "manage_session" },
          });
        } catch (error) {
          console.warn("Web session upsert failed after create.", error);
        }
      }
    }

    if (action === "clear") {
      const clearedSessionId =
        readSessionIdFromArgs(callArgs) || extractSessionIdFromResult(result);
      if (clearedSessionId) {
        try {
          await markWebSessionStatus({
            crawl4aiSessionId: clearedSessionId,
            status: "closed",
            conversationId: conversationId ?? null,
            domain,
          });
        } catch (error) {
          console.warn("Web session close status update failed.", error);
        }
      }
    }
  }

  const usedSessionId = readSessionIdFromArgs(executedArgs);
  let savedArtifactId: string | undefined;
  try {
    const artifact = await saveWebArtifactFromToolResult({
      conversationId: conversationId ?? null,
      domain,
      name,
      args: executedArgs,
      result,
      source,
      sessionId: usedSessionId,
    });
    if (artifact?.id) {
      savedArtifactId = artifact.id;
    }
  } catch (error) {
    console.warn("Web artifact save failed.", error);
  }

  return withMetadata(result, {
    source,
    web_domain: domain,
    session_id_used: usedSessionId ?? undefined,
    session_id_created: createdSessionId ?? undefined,
    session_reuse_hit: Boolean(reusedSessionId),
    artifact_id_saved: savedArtifactId,
    artifact_fresh_hit: false,
    followup_context_hit: followupContextHit || undefined,
    followup_artifact_id: followupArtifactId,
    followup_reason: followupReason,
    decision_source: decisionSource,
    fallback_reason: fallbackReason,
    retry_without_session: retriedWithoutSession || undefined,
    domain,
    session_id: usedSessionId ?? undefined,
    session_reused: Boolean(reusedSessionId),
  });
}
