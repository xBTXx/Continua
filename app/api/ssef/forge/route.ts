import {
  listSSEFRuns,
  type ListSSEFRunsOptions,
} from "@/lib/ssef/repository";
import {
  processQueuedSSEFForgeJobs,
  processSSEFForgeRun,
} from "@/lib/ssef/forge/engine";
import { type SSEFForgeReasoningEffort } from "@/lib/ssef/config";

export const dynamic = "force-dynamic";

function asNonEmptyText(value: string | null) {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toSafeNumber(value: string | null, fallback: number, min: number, max: number) {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function parseListOptions(request: Request): ListSSEFRunsOptions {
  const url = new URL(request.url);
  return {
    limit: toSafeNumber(url.searchParams.get("limit"), 50, 1, 200),
    offset: toSafeNumber(url.searchParams.get("offset"), 0, 0, 1_000_000),
    status: asNonEmptyText(url.searchParams.get("status")),
    proposalId: asNonEmptyText(url.searchParams.get("proposalId")),
    skillVersionId: asNonEmptyText(url.searchParams.get("skillVersionId")),
    runType: "forge_job",
  };
}

export async function GET(request: Request) {
  try {
    const data = await listSSEFRuns(parseListOptions(request));
    return Response.json(data);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to list SSEF forge runs.";
    return new Response(message, { status: 500 });
  }
}

type ProcessRequestBody = {
  runId?: string;
  maxJobs?: number;
  actor?: string;
  generationModel?: string;
  reasoningEffort?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseProcessBody(value: unknown): ProcessRequestBody {
  if (!isRecord(value)) {
    return {};
  }
  const runId =
    typeof value.runId === "string" && value.runId.trim().length > 0
      ? value.runId.trim()
      : undefined;
  const maxJobs = Number(value.maxJobs);
  const actor =
    typeof value.actor === "string" && value.actor.trim().length > 0
      ? value.actor.trim()
      : undefined;
  const generationModel =
    typeof value.generationModel === "string" &&
    value.generationModel.trim().length > 0
      ? value.generationModel.trim()
      : undefined;
  const reasoningEffort =
    typeof value.reasoningEffort === "string" &&
    value.reasoningEffort.trim().length > 0
      ? value.reasoningEffort.trim().toLowerCase()
      : undefined;
  return {
    runId,
    maxJobs: Number.isFinite(maxJobs) ? maxJobs : undefined,
    actor,
    generationModel,
    reasoningEffort,
  };
}

export async function POST(request: Request) {
  try {
    let rawBody: unknown = {};
    try {
      rawBody = await request.json();
    } catch {
      rawBody = {};
    }
    const body = parseProcessBody(rawBody);

    if (body.runId) {
      const result = await processSSEFForgeRun({
        runId: body.runId,
        actor: body.actor,
        generationModel: body.generationModel,
        reasoningEffort: body.reasoningEffort as
          | SSEFForgeReasoningEffort
          | undefined,
      });
      return Response.json({
        mode: "single",
        result,
      });
    }

    const result = await processQueuedSSEFForgeJobs({
      maxJobs: body.maxJobs,
      actor: body.actor,
      generationModel: body.generationModel,
      reasoningEffort: body.reasoningEffort as
        | SSEFForgeReasoningEffort
        | undefined,
    });
    return Response.json({
      mode: "queue",
      ...result,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to process SSEF forge run(s).";
    return new Response(message, { status: 500 });
  }
}
