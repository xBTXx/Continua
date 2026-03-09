import { resetSSEFState } from "@/lib/ssef/admin/service";

export const dynamic = "force-dynamic";

const RESET_CONFIRMATION_PHRASE = "RESET_SSEF";

type ResetBody = {
  actor?: string;
  reason?: string;
  confirm?: string;
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

function parseBody(value: unknown): ResetBody {
  if (!isRecord(value)) {
    return {};
  }
  return {
    actor: asOptionalText(value.actor),
    reason: asOptionalText(value.reason),
    confirm: asOptionalText(value.confirm),
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
    const body = parseBody(rawBody);
    if (body.confirm !== RESET_CONFIRMATION_PHRASE) {
      return new Response(
        `Reset requires confirm='${RESET_CONFIRMATION_PHRASE}'.`,
        { status: 400 }
      );
    }
    const result = await resetSSEFState({
      actor: body.actor,
      reason: body.reason,
    });
    return Response.json(result);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unable to reset SSEF state.";
    return new Response(message, { status: 500 });
  }
}
