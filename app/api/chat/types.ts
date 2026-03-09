import { ChatMessage } from "@/lib/openrouter";

export type ChatPayload = {
    conversationId?: string;
    model?: string;
    messages?: ChatMessage[];
    temperature?: number;
    stream?: boolean;
    reasoning?: Record<string, unknown>;
    webSearchEnabled?: boolean;
    apiKey?: string;
    appUrl?: string;
    debug?: boolean;
    debugTools?: boolean;
};

export type ToolCall = {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
    [key: string]: unknown;
};

export type ToolFlags = {
    hasEmailTools?: boolean;
    hasWikiTools?: boolean;
    hasCrawl4AITools?: boolean;
    hasPersonalMemoryTools?: boolean;
    hasScratchpadTools?: boolean;
    hasCalendarTools?: boolean;
    hasDocTools?: boolean;
    hasCsvTools?: boolean;
    hasArxivTools?: boolean;
    hasMapsTools?: boolean;
    hasSystemTools?: boolean;
    hasUserTools?: boolean;
    hasSSEFProposalTool?: boolean;
    hasSSEFTools?: boolean;
};
