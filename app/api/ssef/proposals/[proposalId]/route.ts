import { deleteSSEFProposalCascade } from "@/lib/ssef/admin/service";

export const dynamic = "force-dynamic";

type RouteParams = {
  params: Promise<{ proposalId: string }>;
};

type DeleteProposalBody = {
  actor?: string;
  reason?: string;
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

function parseDeleteBody(value: unknown): DeleteProposalBody {
  if (!isRecord(value)) {
    return {};
  }
  return {
    actor: asOptionalText(value.actor),
    reason: asOptionalText(value.reason),
  };
}

export async function DELETE(request: Request, { params }: RouteParams) {
  try {
    const { proposalId } = await params;
    let rawBody: unknown = {};
    try {
      rawBody = await request.json();
    } catch {
      rawBody = {};
    }
    const body = parseDeleteBody(rawBody);
    const result = await deleteSSEFProposalCascade({
      proposalId,
      actor: body.actor,
      reason: body.reason,
    });
    return Response.json(result);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unable to delete SSEF proposal.";
    const status =
      message.includes("not found") ||
      message.includes("required") ||
      message.includes("UUID")
        ? 400
        : 500;
    return new Response(message, { status });
  }
}
