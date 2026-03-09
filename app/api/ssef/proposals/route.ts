import { listSSEFProposals } from "@/lib/ssef/repository";

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

function cleanQueryValue(value: string | null) {
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
    const status = cleanQueryValue(url.searchParams.get("status"));
    const proposalType = cleanQueryValue(url.searchParams.get("type"));
    const search = cleanQueryValue(url.searchParams.get("q"));

    const data = await listSSEFProposals({
      limit,
      offset,
      status,
      proposalType,
      search,
    });
    return Response.json(data);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to list SSEF proposals.";
    return new Response(message, { status: 500 });
  }
}
