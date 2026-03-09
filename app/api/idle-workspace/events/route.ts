import { listIdleWorkspaceEvents } from "@/lib/idleWorkspace";

function toNumber(value: string | null, fallback: number) {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limit = Math.min(300, Math.max(1, toNumber(url.searchParams.get("limit"), 80)));
    const offset = Math.max(0, toNumber(url.searchParams.get("offset"), 0));
    const sessionId = url.searchParams.get("sessionId");
    const data = await listIdleWorkspaceEvents(limit, offset, sessionId);
    return Response.json(data);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to load workspace events.";
    return new Response(message, { status: 500 });
  }
}
