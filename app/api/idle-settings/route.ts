import { getIdleConfig, startIdleScheduler } from "@/lib/idleState";
import { setIdleEnabledSetting } from "@/lib/idleSettings";

export async function GET() {
  try {
    const config = await getIdleConfig();
    return Response.json({ enabled: config.enabled });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to load idle settings.";
    return new Response(message, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const payload = (await request.json().catch(() => ({}))) as {
      enabled?: boolean;
    };
    if (typeof payload.enabled !== "boolean") {
      return new Response("Invalid idle settings payload.", { status: 400 });
    }
    await setIdleEnabledSetting(payload.enabled);
    await startIdleScheduler();
    return Response.json({ enabled: payload.enabled });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to update idle settings.";
    return new Response(message, { status: 500 });
  }
}
