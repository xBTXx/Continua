import { ChatMessage } from "@/lib/openrouter";
import { PersonalMemoryContextMessage } from "@/lib/personalMemoryContext";
import { buildPersonalMemoryContext } from "./memoryHelpers";
import { isChatMessage } from "./toolPrompts";
import { ChatPayload } from "./types";

export type ParsedChatRequest = {
  payload: ChatPayload;
  messages: ChatMessage[];
  conversationId: string | null;
  personalMemoryContext: PersonalMemoryContextMessage[];
};

export async function parseChatRequest(
  request: Request
): Promise<ParsedChatRequest | Response> {
  const payload = (await request.json()) as ChatPayload;
  const incomingMessages = payload.messages ?? [];
  const messages = incomingMessages.filter(isChatMessage);
  const conversationId =
    typeof payload.conversationId === "string" && payload.conversationId.trim()
      ? payload.conversationId
      : null;
  const personalMemoryContext = buildPersonalMemoryContext(messages);

  if (!payload.model || messages.length === 0) {
    return new Response("Invalid chat payload.", { status: 400 });
  }

  return {
    payload,
    messages,
    conversationId,
    personalMemoryContext,
  };
}
