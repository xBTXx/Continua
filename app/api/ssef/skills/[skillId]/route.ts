import { deleteSSEFSkillCascade } from "@/lib/ssef/admin/service";

export const dynamic = "force-dynamic";

type RouteParams = {
  params: Promise<{ skillId: string }>;
};

type DeleteSkillBody = {
  actor?: string;
  reason?: string;
  deleteLinkedProposals?: boolean;
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
  return undefined;
}

function parseDeleteBody(value: unknown): DeleteSkillBody {
  if (!isRecord(value)) {
    return {};
  }
  return {
    actor: asOptionalText(value.actor),
    reason: asOptionalText(value.reason),
    deleteLinkedProposals: asOptionalBoolean(value.deleteLinkedProposals),
  };
}

export async function DELETE(request: Request, { params }: RouteParams) {
  try {
    const { skillId } = await params;
    let rawBody: unknown = {};
    try {
      rawBody = await request.json();
    } catch {
      rawBody = {};
    }
    const body = parseDeleteBody(rawBody);
    const result = await deleteSSEFSkillCascade({
      skillId,
      actor: body.actor,
      reason: body.reason,
      deleteLinkedProposals: body.deleteLinkedProposals,
    });
    return Response.json(result);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unable to delete SSEF skill.";
    const status =
      message.includes("not found") ||
      message.includes("required") ||
      message.includes("skillId")
        ? 400
        : 500;
    return new Response(message, { status });
  }
}
