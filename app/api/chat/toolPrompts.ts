import { ChatMessage, ToolDefinition } from "@/lib/openrouter";
import { isChatContentArray } from "@/lib/chatContent";
import {
    ToolCategory
} from "@/lib/tooling";
import {
    emailToolsEnabled,
    getEmailAccountHints,
    getEmailToolDefinitions,
} from "@/lib/emailTools";
import {
    getWikiToolDefinitions,
    wikiToolsEnabled,
} from "@/lib/wikiTools";
import {
    crawl4aiToolsEnabled,
    getCrawl4AIToolDefinitions,
} from "@/lib/crawl4aiTools";
import {
    getPersonalMemoryToolDefinitions,
    personalMemoryToolsEnabled,
} from "@/lib/personalMemoryTools";
import {
    calendarToolsEnabled,
    getCalendarToolDefinitions,
} from "@/lib/calendarTools";
import {
    csvToolsEnabled,
    docToolsEnabled,
    getCsvToolDefinitions,
    getDocToolDefinitions,
} from "@/lib/fileTools";
import {
    arxivToolsEnabled,
    getArxivToolDefinitions,
} from "@/lib/arxivTools";
import {
    getScratchpadToolDefinitions,
    scratchpadToolsEnabled,
} from "@/lib/scratchpadTools";
import {
    getMapsToolDefinitions,
    mapsToolsEnabled,
} from "@/lib/mapsTools";
import {
    getUserToolDefinitions,
    userToolsEnabled,
} from "@/lib/userTools";
import { getSSEFProposalTriggerToolDefinitions } from "@/lib/ssef/proposals/triggerTool";
import {
    getActiveSkillToolDefinitionsBundle,
    type ActiveSSEFSkillCatalogEntry,
} from "@/lib/ssef/runtime/toolDefinitions";
import {
    EMAIL_TOOL_PROMPT_LINES,
    WIKI_TOOL_PROMPT_LINES,
    CRAWL4AI_TOOL_PROMPT_LINES,
    PERSONAL_MEMORY_TOOL_PROMPT_LINES,
    SCRATCHPAD_TOOL_PROMPT_LINES,
    CALENDAR_TOOL_PROMPT_LINES,
    DOC_TOOL_PROMPT_LINES,
    CSV_TOOL_PROMPT_LINES,
    ARXIV_TOOL_PROMPT_LINES,
    MAPS_TOOL_PROMPT_LINES,
    USER_TOOL_PROMPT_LINES,
    SSEF_PROPOSAL_TOOL_PROMPT_LINES,
    SSEF_DYNAMIC_TOOL_PROMPT_LINES,
} from "./constants";
import { ToolFlags } from "./types";

export type BuildToolingBundleOptions = {
    ssefSelectionQuery?: string | null;
    ssefSelectionMaxTools?: number | null;
    ssefSelectionMinScore?: number | null;
    ssefSelectionMaxQueryTokens?: number | null;
};

export function isChatMessage(value: unknown): value is ChatMessage {
    if (!value || typeof value !== "object") {
        return false;
    }
    const message = value as ChatMessage;
    return (
        (message.role === "system" ||
            message.role === "user" ||
            message.role === "assistant") &&
        (typeof message.content === "string" || isChatContentArray(message.content))
    );
}

export function insertToolSystemPrompt(
    messages: ChatMessage[],
    toolFlags?: ToolFlags,
    toolCatalogLines: string[] = []
) {
    const hasEmailTools = toolFlags?.hasEmailTools ?? emailToolsEnabled();
    const hasWikiTools = toolFlags?.hasWikiTools ?? wikiToolsEnabled();
    const hasCrawl4AITools =
        toolFlags?.hasCrawl4AITools ?? crawl4aiToolsEnabled();
    const hasPersonalMemoryTools =
        toolFlags?.hasPersonalMemoryTools ?? personalMemoryToolsEnabled();
    const hasScratchpadTools =
        toolFlags?.hasScratchpadTools ?? scratchpadToolsEnabled();
    const hasCalendarTools = toolFlags?.hasCalendarTools ?? calendarToolsEnabled();
    const hasDocTools = toolFlags?.hasDocTools ?? docToolsEnabled();
    const hasCsvTools = toolFlags?.hasCsvTools ?? csvToolsEnabled();
    const hasArxivTools = toolFlags?.hasArxivTools ?? arxivToolsEnabled();
    const hasMapsTools = toolFlags?.hasMapsTools ?? mapsToolsEnabled();
    const hasUserTools = toolFlags?.hasUserTools ?? userToolsEnabled();
    const hasSSEFProposalTool = toolFlags?.hasSSEFProposalTool ?? false;
    const hasSSEFTools = toolFlags?.hasSSEFTools ?? false;
    if (
        !hasEmailTools &&
        !hasWikiTools &&
        !hasCrawl4AITools &&
        !hasPersonalMemoryTools &&
        !hasScratchpadTools &&
        !hasCalendarTools &&
        !hasDocTools &&
        !hasCsvTools &&
        !hasArxivTools &&
        !hasMapsTools &&
        !hasUserTools &&
        !hasSSEFProposalTool &&
        !hasSSEFTools
    ) {
        return messages;
    }

    const promptLines: string[] = [];
    const normalizedToolCatalogLines = toolCatalogLines
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    if (normalizedToolCatalogLines.length > 0) {
        promptLines.push("Available tools and skills:");
        promptLines.push(
            ...normalizedToolCatalogLines.map((line) => `- ${line}`)
        );
        promptLines.push("");
    }
    if (hasEmailTools) {
        promptLines.push(...EMAIL_TOOL_PROMPT_LINES);
    }
    if (hasWikiTools) {
        promptLines.push(...WIKI_TOOL_PROMPT_LINES);
    }
    if (hasCrawl4AITools) {
        promptLines.push(...CRAWL4AI_TOOL_PROMPT_LINES);
    }
    if (hasPersonalMemoryTools) {
        promptLines.push(...PERSONAL_MEMORY_TOOL_PROMPT_LINES);
    }
    if (hasScratchpadTools) {
        promptLines.push(...SCRATCHPAD_TOOL_PROMPT_LINES);
    }
    if (hasCalendarTools) {
        promptLines.push(...CALENDAR_TOOL_PROMPT_LINES);
    }
    if (hasDocTools) {
        promptLines.push(...DOC_TOOL_PROMPT_LINES);
    }
    if (hasCsvTools) {
        promptLines.push(...CSV_TOOL_PROMPT_LINES);
    }
    if (hasArxivTools) {
        promptLines.push(...ARXIV_TOOL_PROMPT_LINES);
    }
    if (hasMapsTools) {
        promptLines.push(...MAPS_TOOL_PROMPT_LINES);
    }
    if (hasUserTools) {
        promptLines.push(...USER_TOOL_PROMPT_LINES);
    }
    if (hasSSEFProposalTool) {
        promptLines.push(...SSEF_PROPOSAL_TOOL_PROMPT_LINES);
    }
    if (hasSSEFTools) {
        promptLines.push(...SSEF_DYNAMIC_TOOL_PROMPT_LINES);
    }
    promptLines.push(
        "After completing any tool calls, always send a user-facing final answer that summarizes results or remaining blockers."
    );

    let prompt = promptLines.join("\n");
    if (hasEmailTools) {
        const accountHints = getEmailAccountHints();
        const accountLines = accountHints.map(
            (account) =>
                `- ${account.id}: ${account.email} (${account.type})` +
                (account.displayName ? ` [${account.displayName}]` : "")
        );
        if (accountLines.length > 0) {
            prompt = `${prompt}\nConfigured accounts:\n${accountLines.join("\n")}`;
        }
    }
    const toolMessage: ChatMessage = { role: "system", content: prompt };

    const systemIndex = messages.findIndex((message) => message.role === "system");
    if (systemIndex === -1) {
        return [toolMessage, ...messages];
    }
    return [
        ...messages.slice(0, systemIndex + 1),
        toolMessage,
        ...messages.slice(systemIndex + 1),
    ];
}

export async function buildToolingBundle(
    categories: Set<ToolCategory>,
    options: BuildToolingBundleOptions = {}
) {
    const wantsCommunication = categories.has("communication");
    const wantsWeb = categories.has("web");
    const wantsFilesystem =
        categories.has("filesystem") || categories.has("system");
    const wantsAcademic = categories.has("academic");
    const wantsScheduling = categories.has("scheduling");
    const wantsNavigation = categories.has("navigation");

    const emailTools =
        wantsCommunication && emailToolsEnabled() ? getEmailToolDefinitions() : [];
    const wikiTools =
        wantsWeb && wikiToolsEnabled() ? getWikiToolDefinitions() : [];
    const crawl4aiTools =
        wantsWeb && crawl4aiToolsEnabled()
            ? await getCrawl4AIToolDefinitions()
            : [];
    const personalTools = personalMemoryToolsEnabled()
        ? getPersonalMemoryToolDefinitions()
        : [];
    const scratchpadTools = scratchpadToolsEnabled()
        ? getScratchpadToolDefinitions()
        : [];
    const calendarTools =
        wantsScheduling && calendarToolsEnabled() ? getCalendarToolDefinitions() : [];
    const docTools =
        wantsFilesystem && docToolsEnabled() ? getDocToolDefinitions() : [];
    const csvTools =
        wantsFilesystem && csvToolsEnabled() ? getCsvToolDefinitions() : [];
    const arxivTools =
        wantsAcademic && arxivToolsEnabled() ? getArxivToolDefinitions() : [];
    const mapsTools =
        wantsNavigation && mapsToolsEnabled() ? getMapsToolDefinitions() : [];
    const userTools = userToolsEnabled() ? getUserToolDefinitions() : [];
    const ssefProposalTools = getSSEFProposalTriggerToolDefinitions();
    const ssefToolBundle = await getActiveSkillToolDefinitionsBundle({
        queryText: options.ssefSelectionQuery ?? "",
        maxTools:
            typeof options.ssefSelectionMaxTools === "number"
                ? options.ssefSelectionMaxTools
                : undefined,
        minScore:
            typeof options.ssefSelectionMinScore === "number"
                ? options.ssefSelectionMinScore
                : undefined,
        maxQueryTokens:
            typeof options.ssefSelectionMaxQueryTokens === "number"
                ? options.ssefSelectionMaxQueryTokens
                : undefined,
    });
    const rawSSEFTools = ssefToolBundle.selectedTools;

    const staticToolNameSet = new Set<string>([
        ...emailTools,
        ...wikiTools,
        ...crawl4aiTools,
        ...personalTools,
        ...scratchpadTools,
        ...calendarTools,
        ...docTools,
        ...csvTools,
        ...arxivTools,
        ...mapsTools,
        ...userTools,
        ...ssefProposalTools,
    ].map((tool) => tool.function.name));
    const ssefTools = rawSSEFTools.filter(
        (tool) => !staticToolNameSet.has(tool.function.name)
    );

    const tools = [
        ...emailTools,
        ...wikiTools,
        ...crawl4aiTools,
        ...personalTools,
        ...scratchpadTools,
        ...calendarTools,
        ...docTools,
        ...csvTools,
        ...arxivTools,
        ...mapsTools,
        ...userTools,
        ...ssefProposalTools,
        ...ssefTools,
    ];

    const toolNameSet = new Set(tools.map((tool) => tool.function.name));
    const toolCatalogLines = buildToolCatalogLines(
        tools,
        ssefToolBundle.activeCatalogEntries
    );

    return {
        tools,
        toolNameSet,
        toolCatalogLines,
        toolFlags: {
            hasEmailTools: emailTools.length > 0,
            hasWikiTools: wikiTools.length > 0,
            hasCrawl4AITools: crawl4aiTools.length > 0,
            hasPersonalMemoryTools: personalTools.length > 0,
            hasScratchpadTools: scratchpadTools.length > 0,
            hasCalendarTools: calendarTools.length > 0,
            hasDocTools: docTools.length > 0,
            hasCsvTools: csvTools.length > 0,
            hasArxivTools: arxivTools.length > 0,
            hasMapsTools: mapsTools.length > 0,
            hasUserTools: userTools.length > 0,
            hasSSEFProposalTool: ssefProposalTools.length > 0,
            hasSSEFTools: ssefTools.length > 0,
        },
    };
}

function buildToolCatalogLines(
    tools: ToolDefinition[],
    extraEntries: ActiveSSEFSkillCatalogEntry[] = []
) {
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const tool of tools) {
        const name = tool.function.name.trim();
        if (!name || seen.has(name)) {
            continue;
        }
        seen.add(name);
        const summary = summarizeToolDescription(tool.function.description);
        lines.push(`${name}: ${summary}`);
    }
    for (const entry of extraEntries) {
        const name = entry.name.trim();
        if (!name || seen.has(name)) {
            continue;
        }
        seen.add(name);
        const summary = summarizeToolDescription(entry.description);
        lines.push(`${name}: ${summary}`);
    }
    return lines;
}

function summarizeToolDescription(description: string | undefined) {
    if (!description) {
        return "available tool";
    }
    const normalized = description.replace(/\s+/g, " ").trim();
    if (!normalized) {
        return "available tool";
    }
    const firstSentence = normalized.split(/[.!?](?:\s|$)/, 1)[0]?.trim() ?? "";
    const base = firstSentence || normalized;
    const maxLength = 80;
    if (base.length <= maxLength) {
        return base;
    }
    const clipped = base.slice(0, maxLength).trimEnd();
    const lastSpace = clipped.lastIndexOf(" ");
    const truncated = lastSpace > 20 ? clipped.slice(0, lastSpace) : clipped;
    return `${truncated}...`;
}
