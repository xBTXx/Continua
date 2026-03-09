import {
  runIdleResonanceBackfill,
  IdleResonanceBackfillOptions,
} from "@/lib/idleResonanceBackfill";

export async function POST(request: Request) {
  try {
    const payload = (await request.json().catch(() => ({}))) as IdleResonanceBackfillOptions;
    const result = await runIdleResonanceBackfill(payload);
    return Response.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to backfill idle memories.";
    return new Response(message, { status: 500 });
  }
}
