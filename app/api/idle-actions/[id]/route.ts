import {
  getIdleActionPlanById,
  saveIdleActionLogEntries,
  updateIdleActionStatus,
} from "@/lib/idleActions";
import { createIdleConversation } from "@/lib/idleConversations";

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const payload = (await request.json().catch(() => ({}))) as {
      action?: string;
    };
    const actionType =
      typeof payload.action === "string" && payload.action.trim().length > 0
        ? payload.action.trim()
        : "start_conversation";

    const plan = await getIdleActionPlanById(id);
    if (!plan) {
      return new Response("Idle action not found.", { status: 404 });
    }
    if (plan.status !== "pending") {
      return new Response("Idle action already processed.", { status: 409 });
    }

    const action = plan.actions.find((entry) => entry.type === actionType);
    if (!action) {
      return new Response("Requested action not found on plan.", { status: 400 });
    }

    if (actionType !== "start_conversation") {
      return new Response("Action type not supported yet.", { status: 400 });
    }

    const { conversationId } = await createIdleConversation({
      thoughtText: plan.thoughtText,
      action,
    });

    await updateIdleActionStatus(plan.id, "complete");
    try {
      await saveIdleActionLogEntries({
        planId: plan.id,
        thoughtText: plan.thoughtText,
        actions: [action],
        model: plan.model ?? null,
        source: "executed",
      });
    } catch (error) {
      console.warn("Idle action execution log failed.", error);
    }

    return Response.json({
      status: "ok",
      conversationId,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unable to apply idle action.";
    return new Response(message, { status: 500 });
  }
}
