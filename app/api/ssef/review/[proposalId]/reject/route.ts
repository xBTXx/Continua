import { rejectSSEFProposalPromotion } from "@/lib/ssef/promotion/service";

export const dynamic = "force-dynamic";

type RouteParams = {
  params: Promise<{ proposalId: string }>;
};

type RejectBody = {
  actor?: string;
  reason?: string;
  note?: string;
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

function parseRejectBody(value: unknown): RejectBody {
  if (!isRecord(value)) {
    return {};
  }
  return {
    actor: asOptionalText(value.actor),
    reason: asOptionalText(value.reason),
    note: asOptionalText(value.note),
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

    const body = parseRejectBody(rawBody);
    const result = await rejectSSEFProposalPromotion({
      proposalId,
      actor: body.actor,
      reason: body.reason,
      note: body.note,
    });
    return Response.json(result);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unable to reject SSEF proposal promotion.";
    const status = message.includes("not rejectable") || message.includes("not found")
      ? 400
      : 500;
    return new Response(message, { status });
  }
}
