import { rollbackSSEFProposalPromotion } from "@/lib/ssef/promotion/rollback";

export const dynamic = "force-dynamic";

type RouteParams = {
  params: Promise<{ proposalId: string }>;
};

type RollbackBody = {
  actor?: string;
  reason?: string;
  disableOnly?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asOptionalText(value: unknown) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asOptionalBoolean(value: unknown) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (value === "true") {
      return true;
    }
    if (value === "false") {
      return false;
    }
  }
  return undefined;
}

function parseRollbackBody(value: unknown): RollbackBody {
  if (!isRecord(value)) {
    return {};
  }
  return {
    actor: asOptionalText(value.actor),
    reason: asOptionalText(value.reason),
    disableOnly: asOptionalBoolean(value.disableOnly),
  };
}

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { proposalId } = await params;
    let rawBody: unknown = {};
    try {
      rawBody = await request.json();
    } catch {
      rawBody = {};
    }

    const body = parseRollbackBody(rawBody);
    const result = await rollbackSSEFProposalPromotion({
      proposalId,
      actor: body.actor,
      reason: body.reason,
      disableOnly: body.disableOnly,
    });
    return Response.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to rollback SSEF promotion.";
    const status =
      message.includes("not found") ||
      message.includes("cannot be rolled back") ||
      message.includes("requires proposal version")
        ? 400
        : 500;
    return new Response(message, { status });
  }
}
