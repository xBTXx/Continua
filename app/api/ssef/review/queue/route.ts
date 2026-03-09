import { listSSEFReviewQueue } from "@/lib/ssef/promotion/service";

export const dynamic = "force-dynamic";

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

function asNonEmptyText(value: string | null) {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limit = toSafeNumber(url.searchParams.get("limit"), 50, 1, 200);
    const offset = toSafeNumber(url.searchParams.get("offset"), 0, 0, 1_000_000);
    const status = asNonEmptyText(url.searchParams.get("status"));

    const data = await listSSEFReviewQueue({
      limit,
      offset,
      status,
    });
    return Response.json(data);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to load SSEF review queue.";
    return new Response(message, { status: 500 });
  }
}
