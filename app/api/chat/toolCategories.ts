import { ChatMessage } from "@/lib/openrouter";
import { extractTextFromContent } from "@/lib/chatContent";
import {
    ToolCategory
} from "@/lib/tooling";
import { isCrawl4AIToolName } from "@/lib/crawl4aiTools";
import { ToolCall } from "./types";
import {
    EMAIL_TOOL_SET,
    WIKI_TOOL_SET,
    DOC_TOOL_SET,
    CSV_TOOL_SET,
    ARXIV_TOOL_SET,
    CALENDAR_TOOL_SET,
    SYSTEM_TOOL_SET,
    USER_TOOL_SET,
} from "./constants";

export function mergeToolCategories(...groups: Array<Iterable<ToolCategory> | undefined>) {
    const merged = new Set<ToolCategory>();
    groups.forEach((group) => {
        if (!group) {
            return;
        }
        for (const category of group) {
            merged.add(category);
        }
    });
    return Array.from(merged);
}

export function isShortAckMessage(text: string) {
    const trimmed = text.trim().toLowerCase();
    if (!trimmed || trimmed.length > 60) {
        return false;
    }
    return /^(yes|yeah|yep|ok|okay|sure|please|go ahead|do it|send it|sounds good|let's do it|make it so)(\W.*)?$/.test(
        trimmed
    );
}

export function inferFollowupToolCategories(
    lastUserMessage?: ChatMessage,
    lastAssistantMessage?: ChatMessage
) {
    if (!lastUserMessage || !lastAssistantMessage) {
        return [];
    }
    const userText = extractTextFromContent(lastUserMessage.content)
        .trim()
        .toLowerCase();
    const assistantText = extractTextFromContent(lastAssistantMessage.content)
        .toLowerCase();
    if (!isShortAckMessage(userText)) {
        return [];
    }

    const matches: ToolCategory[] = [];
    if (assistantText.includes("email") || assistantText.includes("draft")) {
        matches.push("communication");
    }
    if (assistantText.includes("calendar") || assistantText.includes("event")) {
        matches.push("scheduling");
    }
    if (
        assistantText.includes("file") ||
        assistantText.includes("workspace") ||
        assistantText.includes("csv") ||
        assistantText.includes("markdown")
    ) {
        matches.push("filesystem");
    }
    if (assistantText.includes("arxiv")) {
        matches.push("academic");
    }
    if (
        assistantText.includes("wikipedia") ||
        assistantText.includes("crawl4ai") ||
        assistantText.includes("web")
    ) {
        matches.push("web");
    }
    if (
        assistantText.includes("source code") ||
        assistantText.includes("repo") ||
        assistantText.includes("readme")
    ) {
        matches.push("system");
    }
    return Array.from(new Set(matches));
}

export function mapToolNameToCategory(name: string): ToolCategory | null {
    if (EMAIL_TOOL_SET.has(name)) {
        return "communication";
    }
    if (WIKI_TOOL_SET.has(name) || name.includes("crawl4ai") || name.startsWith("c4a_")) {
        return "web";
    }
    if (DOC_TOOL_SET.has(name) || CSV_TOOL_SET.has(name)) {
        return "filesystem";
    }
    if (ARXIV_TOOL_SET.has(name)) {
        return "academic";
    }
    if (CALENDAR_TOOL_SET.has(name)) {
        return "scheduling";
    }
    if (SYSTEM_TOOL_SET.has(name)) {
        return "system";
    }
    if (USER_TOOL_SET.has(name)) {
        return "system";
    }
    return null;
}

export async function getMissingToolCategories(
    toolCalls: ToolCall[],
    toolNameSet: Set<string>
) {
    const missing = new Set<ToolCategory>();
    for (const call of toolCalls) {
        const name = call.function.name;
        if (toolNameSet.has(name)) {
            continue;
        }
        const category = mapToolNameToCategory(name);
        if (category) {
            missing.add(category);
            continue;
        }
        if (await isCrawl4AIToolName(name)) {
            missing.add("web");
        }
    }
    return Array.from(missing);
}
