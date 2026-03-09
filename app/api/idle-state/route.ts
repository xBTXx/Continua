import { getIdleStateSnapshotDetailed, startIdleScheduler } from "@/lib/idleState";

export async function GET() {
  try {
    await startIdleScheduler();
    const state = await getIdleStateSnapshotDetailed();
    return Response.json(state);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to load idle state.";
    return new Response(message, { status: 500 });
  }
}
