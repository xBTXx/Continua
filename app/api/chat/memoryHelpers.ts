import { ChatMessage } from "@/lib/openrouter";
import { extractTextFromContent } from "@/lib/chatContent";
import { PersonalMemoryContextMessage } from "@/lib/personalMemoryContext";
import { CalendarEvent } from "@/lib/calendarTools";
import { formatDateTime } from "@/lib/chatUtils";
import { PERSONAL_MEMORY_CONTEXT_LIMIT } from "./constants";

export function buildCalendarReminder(event: CalendarEvent) {
    const scheduledAt = event.nextTriggerAt ?? event.startTime;
    const scheduledDate = scheduledAt ? new Date(scheduledAt) : null;
    const timeLabel =
        scheduledDate && !Number.isNaN(scheduledDate.getTime())
            ? ` at ${formatDateTime(scheduledDate)}`
            : "";
    const noteLabel =
        event.description && event.description.trim()
            ? ` Notes: ${event.description.trim()}`
            : "";
    return `Reminder: you have a scheduled event "${event.title}"${timeLabel}.${noteLabel}`.trim();
}

export function truncateText(text: string, maxLength: number) {
    const trimmed = text.trim();
    if (trimmed.length <= maxLength) {
        return trimmed;
    }
    return `${trimmed.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function buildPersonalMemoryContext(
    messages: ChatMessage[]
): PersonalMemoryContextMessage[] {
    const filtered = messages.filter(
        (message): message is ChatMessage & { role: "user" | "assistant" } =>
            message.role === "user" || message.role === "assistant"
    );

    return filtered
        .slice(-PERSONAL_MEMORY_CONTEXT_LIMIT)
        .map((message) => ({
            role: message.role,
            content: extractTextFromContent(message.content),
        }))
        .filter((message) => message.content.trim().length > 0);
}
