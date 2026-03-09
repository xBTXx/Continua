import { listIdleTickMetrics } from "@/lib/idleMetrics";
import { startIdleScheduler } from "@/lib/idleState";

function toNumber(value: string | null, fallback: number) {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function GET(request: Request) {
  try {
    await startIdleScheduler();
    const url = new URL(request.url);
    const limit = Math.min(200, Math.max(1, toNumber(url.searchParams.get("limit"), 50)));
    const offset = Math.max(0, toNumber(url.searchParams.get("offset"), 0));
    const data = await listIdleTickMetrics(limit, offset);
    return Response.json(data);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to load idle metrics.";
    return new Response(message, { status: 500 });
  }
}
