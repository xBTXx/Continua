import { listIdleWorkspaceSessions } from "@/lib/idleWorkspace";

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
    const limit = Math.min(200, Math.max(1, toNumber(url.searchParams.get("limit"), 30)));
    const offset = Math.max(0, toNumber(url.searchParams.get("offset"), 0));
    const status = url.searchParams.get("status");
    const data = await listIdleWorkspaceSessions(limit, offset, status);
    return Response.json(data);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to load workspace sessions.";
    return new Response(message, { status: 500 });
  }
}
