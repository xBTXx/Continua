import { runMemoryAgent } from "@/lib/memoryAgent";

// Memory consolidation involves multiple LLM calls and can take some time
export const maxDuration = 120; // 2 minutes max

type MemoryPayload = {
  conversationId?: string;
  messages?: Array<{ id?: string; role?: string; content?: string }>;
  apiKey?: string;
  appUrl?: string;
};

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as MemoryPayload;
    const messages =
      payload.messages?.filter(
        (
          message
        ): message is {
          id?: string;
          role: "user" | "assistant";
          content: string;
        } =>
          (message.role === "user" || message.role === "assistant") &&
          typeof message.content === "string"
      ) ?? [];

    if (messages.length === 0) {
      return Response.json({
        status: "skipped",
        reason: "No messages provided.",
      });
    }

    const result = await runMemoryAgent({
      messages,
      conversationId: payload.conversationId ?? null,
      apiKey: payload.apiKey,
      appUrl: payload.appUrl,
    });

    return Response.json({ status: "ok", ...result });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected error";
    console.error("Memory agent error:", message);
    return new Response(message, { status: 500 });
  }
}
