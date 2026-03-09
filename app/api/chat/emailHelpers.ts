import { ChatMessage } from "@/lib/openrouter";
import { extractTextFromContent } from "@/lib/chatContent";

type JsonObject = Record<string, unknown>;
type MailAddress = {
    name?: string;
    address?: string;
};
type MessageEnvelope = {
    messageId?: string;
    subject?: string;
    from?: MailAddress[];
};
type ListedMessage = JsonObject & {
    id?: unknown;
    envelope?: MessageEnvelope;
};

export function getLastListMessages(toolMessages: ChatMessage[]) {
    for (let i = toolMessages.length - 1; i >= 0; i -= 1) {
        const message = toolMessages[i];
        if (message.role === "tool" && message.name === "list_messages") {
            try {
                const parsed = JSON.parse(extractTextFromContent(message.content));
                if (Array.isArray(parsed)) {
                    return parsed as ListedMessage[];
                }
            } catch {
                return null;
            }
        }
    }
    return null;
}

export function getLastToolResult(
    toolMessages: ChatMessage[],
    name: string
): JsonObject | null {
    for (let i = toolMessages.length - 1; i >= 0; i -= 1) {
        const message = toolMessages[i];
        if (message.role === "tool" && message.name === name) {
            try {
                const parsed = JSON.parse(extractTextFromContent(message.content));
                if (parsed && typeof parsed === "object") {
                    return parsed as JsonObject;
                }
            } catch {
                return null;
            }
        }
    }
    return null;
}

export function normalizeMessageIdValue(value: unknown) {
    if (typeof value !== "string") {
        return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }
    if (/^\d+$/.test(trimmed)) {
        return trimmed;
    }
    return trimmed;
}

export function resolveMessageIdFromHistory(
    args: Record<string, unknown>,
    toolMessages: ChatMessage[]
) {
    const messageIdRaw = normalizeMessageIdValue(args.message_id);
    const results = getLastListMessages(toolMessages);
    const lastMessage = getLastToolResult(toolMessages, "get_message");
    const lastMessageId =
        lastMessage && typeof lastMessage.id !== "undefined"
            ? String(lastMessage.id)
            : null;

    if (messageIdRaw && /^\d+$/.test(messageIdRaw)) {
        const inList =
            Array.isArray(results) &&
            results.some((item) => String(item?.id) === messageIdRaw);
        if (inList || lastMessageId === messageIdRaw) {
            return messageIdRaw;
        }
        if (lastMessageId) {
            return lastMessageId;
        }
        return messageIdRaw;
    }

    if (!results || results.length === 0) {
        return lastMessageId || messageIdRaw || null;
    }

    const indexValue =
        typeof args.message_index === "number"
            ? args.message_index
            : typeof args.index === "number"
                ? args.index
                : null;
    if (indexValue && Number.isFinite(indexValue)) {
        const idx = Math.max(1, Math.floor(indexValue));
        const item = results[idx - 1];
        if (item?.id) {
            return String(item.id);
        }
    }

    if (typeof messageIdRaw === "string") {
        const normalized = messageIdRaw.toLowerCase();
        if (normalized === "first" || normalized === "latest" || normalized === "newest") {
            return String(results[0]?.id ?? messageIdRaw);
        }
        if (normalized === "last" || normalized === "oldest") {
            return String(results[results.length - 1]?.id ?? messageIdRaw);
        }
    }

    if (typeof messageIdRaw === "string") {
        const query = messageIdRaw.toLowerCase();
        const match =
            results.find(
                (item) =>
                    String(item.id) === messageIdRaw ||
                    String(item?.envelope?.messageId || "")
                        .toLowerCase()
                        .includes(query) ||
                    String(item?.envelope?.subject || "").toLowerCase().includes(query) ||
                    (item?.envelope?.from || []).some((from) =>
                        `${from?.name || ""} ${from?.address || ""}`
                            .toLowerCase()
                            .includes(query)
                    )
            ) || null;
        if (match?.id) {
            return String(match.id);
        }
    }

    return lastMessageId || messageIdRaw || null;
}
