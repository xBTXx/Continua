import {
    MemorySnippet,
    ConversationExcerpt,
    buildMemoryBlock,
    buildConversationExcerptBlock
} from "@/lib/retrieval";
import { truncateText } from "./memoryHelpers";
import {
    EXCERPT_LOG_MEMORY_MAX_CHARS,
    EXCERPT_LOG_MESSAGE_MAX_CHARS
} from "./constants";

export function streamTextResponse(text: string, headers?: Record<string, string>) {
    const encoder = new TextEncoder();
    const safeText =
        typeof text === "string" && text.trim().length > 0
            ? text
            : "Tool results were returned, but the model did not provide a summary.";
    const chunkSize = 120;
    let offset = 0;

    const stream = new ReadableStream({
        start(controller) {
            while (offset < safeText.length) {
                const chunk = safeText.slice(offset, offset + chunkSize);
                const payload = JSON.stringify({
                    choices: [{ delta: { content: chunk } }],
                });
                controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
                offset += chunkSize;
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
        },
    });

    return new Response(stream, {
        headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
            ...headers,
        },
    });
}

export function buildResponseHeaders(
    personalMemoryUsed: boolean,
    injectionId: string | null
) {
    const headers: Record<string, string> = {};
    if (personalMemoryUsed) {
        headers["X-Assistant-Personal-Memory"] = "1";
    }
    if (injectionId) {
        headers["X-Assistant-Injection-Id"] = injectionId;
    }
    return Object.keys(headers).length > 0 ? headers : undefined;
}

export function resolveMemoryTimestamp(memory: MemorySnippet) {
    return memory.sourceAt ?? memory.createdAt ?? null;
}

export function dedupeMemories(memories: MemorySnippet[]) {
    const deduped = new Map<string, MemorySnippet>();
    for (const memory of memories) {
        const memoryId = memory.id?.trim();
        const key = memoryId
            ? `id:${memoryId}`
            : `content:${memory.content.toLowerCase().trim()}`;
        const existing = deduped.get(key);
        if (!existing) {
            deduped.set(key, memory);
            continue;
        }
        const existingTime = resolveMemoryTimestamp(existing);
        const incomingTime = resolveMemoryTimestamp(memory);
        if (!existingTime && incomingTime) {
            deduped.set(key, memory);
        } else if (existingTime && incomingTime && incomingTime > existingTime) {
            deduped.set(key, memory);
        }
    }

    return Array.from(deduped.values()).sort((a, b) => {
        const aTime = resolveMemoryTimestamp(a);
        const bTime = resolveMemoryTimestamp(b);
        if (aTime && bTime) {
            return bTime.localeCompare(aTime);
        }
        if (aTime) {
            return -1;
        }
        if (bTime) {
            return 1;
        }
        return 0;
    });
}

export function summarizeConversationExcerpts(
    excerpts: Array<{
        conversationId: string;
        memoryContent: string;
        messages: Array<{ id: string; role: string; content: string; createdAt: string }>;
    }>
) {
    return excerpts.map((excerpt) => ({
        conversationId: excerpt.conversationId,
        memoryContent: truncateText(excerpt.memoryContent, EXCERPT_LOG_MEMORY_MAX_CHARS),
        messages: excerpt.messages.map((message) => ({
            id: message.id,
            role: message.role,
            content: truncateText(message.content, EXCERPT_LOG_MESSAGE_MAX_CHARS),
            createdAt: message.createdAt,
        })),
    }));
}

export function buildInjectedBlocks({
    injectedMemories,
    injectedPersonalMemories,
    conversationExcerpts,
    scratchpadNotes,
    calendarReminders,
    toolHistory,
    workspaceHistory,
}: {
    injectedMemories: MemorySnippet[];
    injectedPersonalMemories: MemorySnippet[];
    conversationExcerpts: ConversationExcerpt[];
    scratchpadNotes: MemorySnippet[];
    calendarReminders: MemorySnippet[];
    toolHistory: string | null;
    workspaceHistory: string | null;
}) {
    const blocks: Array<{ label: string; content: string }> = [];
    if (injectedMemories.length > 0) {
        blocks.push({
            label: "Relevant memories",
            content: buildMemoryBlock("Relevant memories:", injectedMemories),
        });
    }
    if (injectedPersonalMemories.length > 0) {
        blocks.push({
            label: "Assistant personal memories",
            content: buildMemoryBlock(
                "Assistant personal memories:",
                injectedPersonalMemories
            ),
        });
    }
    if (conversationExcerpts.length > 0) {
        blocks.push({
            label: "Conversation excerpts",
            content: buildConversationExcerptBlock(conversationExcerpts),
        });
    }
    if (scratchpadNotes.length > 0) {
        blocks.push({
            label: "Scratchpad notes",
            content: buildMemoryBlock("Scratchpad notes (temporary):", scratchpadNotes),
        });
    }
    if (calendarReminders.length > 0) {
        blocks.push({
            label: "Calendar reminders",
            content: buildMemoryBlock("Calendar reminders (due):", calendarReminders),
        });
    }
    if (toolHistory && toolHistory !== "None") {
        blocks.push({
            label: "Tool history",
            content: `Recent activity (rolling log of last tool uses and idle thoughts):\n${toolHistory}`,
        });
    }
    if (workspaceHistory) {
        blocks.push({
            label: "Workspace summaries",
            content: `Recent idle workspace summaries:\n${workspaceHistory}`,
        });
    }
    return blocks;
}
