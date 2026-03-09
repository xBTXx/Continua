import { saveChatToolLog } from "@/lib/idleActions";
import { runEmailTool } from "@/lib/emailTools";
import { runWikiTool } from "@/lib/wikiTools";
import {
    isCrawl4AIToolName
} from "@/lib/crawl4aiTools";
import { runCrawl4AIToolOrchestrated } from "@/lib/crawl4aiOrchestrator";
import { runPersonalMemoryTool } from "@/lib/personalMemoryTools";
import { runScratchpadTool } from "@/lib/scratchpadTools";
import { runCalendarTool } from "@/lib/calendarTools";
import {
    runCsvTool,
    runDocTool
} from "@/lib/fileTools";
import { runArxivTool } from "@/lib/arxivTools";
import { runMapsTool } from "@/lib/mapsTools";
import { runUserTool } from "@/lib/userTools";
import {
    isSSEFProposalTriggerToolName,
    runSSEFProposalTriggerTool,
} from "@/lib/ssef/proposals/triggerTool";
import { runSSEFToolByName } from "@/lib/ssef/runtime/adapter";
import {
    EMAIL_TOOL_SET,
    WIKI_TOOL_SET,
    PERSONAL_MEMORY_TOOL_SET,
    SCRATCHPAD_TOOL_SET,
    CALENDAR_TOOL_SET,
    DOC_TOOL_SET,
    CSV_TOOL_SET,
    ARXIV_TOOL_SET,
    MAPS_TOOL_SET,
    SYSTEM_TOOL_SET,
    USER_TOOL_SET,
} from "./constants";

export async function logChatToolUse(
    name: string,
    args: Record<string, unknown>,
    result: unknown,
    model?: string
) {
    // Skip personal memory and status/list accounts as they are low-info for rolling history
    if (
        name === "save_personal_memory" ||
        name === "list_accounts" ||
        name === "get_tool_status"
    ) {
        return;
    }

    let summary = "";

    if (name === "list_messages") {
        summary = "Assistant checked the mailbox.";
    } else if (name === "get_message") {
        summary = `Assistant read email ${args.message_id || ""}.`;
    } else if (name === "create_draft" || name === "send_message") {
        const to = Array.isArray(args.to) ? args.to[0] : args.to || "someone";
        const sub = typeof args.subject === "string" ? `: ${args.subject}` : "";
        summary = `Assistant ${name === "create_draft" ? "drafted" : "sent"
            } an email to ${to}${sub}`;
    } else if (name === "reply") {
        summary = `Assistant replied to email ${args.message_id || ""}.`;
    } else if (name === "wiki_search") {
        summary = `Assistant searched Wikipedia for "${args.query || ""}".`;
    } else if (name === "wiki_summary" || name === "wiki_page") {
        summary = `Assistant read Wikipedia page for "${args.title || ""}".`;
    } else if (name === "save_note") {
        summary = "Assistant saved a scratchpad note.";
    } else if (name === "list_notes") {
        summary = "Assistant reviewed scratchpad notes.";
    } else if (name === "edit_note") {
        summary = "Assistant edited a scratchpad note.";
    } else if (name === "delete_note") {
        summary = "Assistant deleted a scratchpad note.";
    } else if (name.includes("crawl4ai") || name.startsWith("c4a_")) {
        const url = typeof args.url === "string" ? args.url : "";
        const query = typeof args.query === "string" ? args.query : "";
        if (name.includes("search") && query) {
            summary = `Assistant searched the web for "${query}".`;
        } else if (name.includes("map") && url) {
            summary = `Assistant mapped site ${url}.`;
        } else if (name.includes("crawl") && url) {
            summary = `Assistant crawled site ${url}.`;
        } else if ((name.includes("scrape") || name.includes("fetch")) && url) {
            summary = `Assistant fetched ${url}.`;
        } else {
            summary = `Assistant used Crawl4AI (${name}).`;
        }
    } else if (name.includes("calendar")) {
        if (name === "add_calendar_event") {
            summary = `Assistant scheduled "${args.title || "an event"}".`;
        } else if (name === "list_calendar_events") {
            summary = "Assistant checked the calendar.";
        } else if (name === "update_calendar_event") {
            summary = `Assistant updated event ${args.event_id || ""}.`;
        } else if (name === "delete_calendar_event") {
            summary = `Assistant deleted event ${args.event_id || ""}.`;
        }
    } else if (name === "fs_bulk_manager") {
        const action =
            typeof args.action === "string" ? args.action : "search";
        const basePath = typeof args.path === "string" ? args.path : "/";
        summary = `Assistant ran fs_bulk_manager (${action}) on ${basePath}.`;
    } else if (name.startsWith("doc_")) {
        if (name === "doc_create_file") {
            summary = `Assistant created ${args.path || "a file"}.`;
        } else if (name === "doc_read_file") {
            summary = `Assistant read ${args.path || "a file"}.`;
        } else if (name === "doc_update_file") {
            summary = `Assistant updated ${args.path || "a file"}.`;
        } else if (name === "doc_apply_patch") {
            summary = "Assistant applied a patch to workspace files.";
        } else if (name === "doc_delete_file") {
            summary = `Assistant deleted ${args.path || "a file"}.`;
        } else if (name === "doc_list_dir") {
            summary = `Assistant listed ${args.path || "a directory"}.`;
        } else if (name === "doc_search") {
            summary = "Assistant searched files.";
        } else if (name === "doc_create_dir") {
            summary = `Assistant created ${args.path || "a directory"}.`;
        } else if (name === "doc_stat") {
            summary = `Assistant checked ${args.path || "a path"}.`;
        } else if (name === "doc_move") {
            summary = `Assistant moved ${args.path || "a path"}.`;
        } else if (name === "doc_copy") {
            summary = `Assistant copied ${args.path || "a path"}.`;
        } else if (name === "doc_rename") {
            summary = `Assistant renamed ${args.path || "a path"}.`;
        } else if (name === "doc_list_trash") {
            summary = "Assistant listed the recycle bin.";
        } else if (name === "doc_restore") {
            summary = "Assistant restored a recycled item.";
        } else {
            summary = "Assistant managed workspace files.";
        }
    } else if (name.startsWith("csv_")) {
        if (name === "csv_create_file") {
            summary = `Assistant created ${args.path || "a CSV file"}.`;
        } else if (name === "csv_read") {
            summary = `Assistant read ${args.path || "a CSV file"}.`;
        } else if (name === "csv_append_rows") {
            summary = `Assistant appended rows to ${args.path || "a CSV file"}.`;
        } else if (name === "csv_filter_rows") {
            summary = `Assistant filtered ${args.path || "a CSV file"}.`;
        } else if (name === "csv_update_rows") {
            summary = `Assistant updated rows in ${args.path || "a CSV file"}.`;
        } else if (name === "csv_delete_rows") {
            summary = `Assistant deleted rows from ${args.path || "a CSV file"}.`;
        } else if (name === "csv_column_totals") {
            summary = `Assistant summarized ${args.path || "a CSV file"}.`;
        }
    } else if (name === "arxiv_search") {
        const query =
            typeof args.search_query === "string"
                ? args.search_query
                : args.query || "";
        summary = `Assistant searched arXiv for "${query}".`;
    } else if (name === "arxiv_fetch") {
        summary = `Assistant retrieved an arXiv paper (${args.id || ""}).`;
    } else if (name.startsWith("system_")) {
        if (name === "system_list_dir") {
            summary = `Assistant listed system directory ${args.path || "."}.`;
        } else if (name === "system_read_file") {
            summary = `Assistant read system file ${args.path || "unknown"}.`;
        }
    } else if (name.startsWith("maps_")) {
        if (name === "maps_get_directions") {
            const origin = typeof args.origin === "string" ? args.origin : "";
            const destination = typeof args.destination === "string" ? args.destination : "";
            summary = `Assistant checked directions from ${origin || "origin"} to ${destination || "destination"}.`;
        } else if (name === "maps_distance_matrix") {
            summary = "Assistant compared distances between multiple locations.";
        } else {
            summary = `Assistant used maps tool (${name}).`;
        }
    } else if (name === "create_user") {
        const action = typeof args.action === "string" ? args.action : "create";
        const username =
            typeof args.username === "string"
                ? args.username
                : typeof args.login === "string"
                    ? args.login
                    : "unknown";
        summary = `Assistant executed create_user (${action}) for ${username}.`;
    } else if (name === "ssef_propose_skill") {
        const preferredName =
            typeof args.skill_name === "string"
                ? args.skill_name.trim()
                : "";
        const outcome =
            typeof args.desired_outcome === "string"
                ? args.desired_outcome
                : "a new capability";
        summary = preferredName
            ? `Assistant submitted an SSEF spark proposal for ${preferredName} (${outcome}).`
            : `Assistant submitted an SSEF spark proposal for ${outcome}.`;
    } else {
        summary = `Assistant used ${name}.`;
    }

    if (summary) {
        const metadata =
            result &&
                typeof result === "object" &&
                "_assistant_web" in result &&
                result._assistant_web &&
                typeof result._assistant_web === "object"
                ? (result._assistant_web as Record<string, unknown>)
                : undefined;
        try {
            await saveChatToolLog({
                actionType: name,
                summary,
                actionData: { args, result },
                metadata,
                model,
            });
        } catch (error) {
            console.warn("Failed to log chat tool use.", error);
        }
    }
}

export async function runTool(
    name: string,
    args: Record<string, unknown>,
    context?: {
        apiKey?: string;
        appUrl?: string;
        model?: string;
        modelLite?: string;
        conversationId?: string | null;
        userIntent?: string | null;
    }
) {
    if (EMAIL_TOOL_SET.has(name)) {
        return runEmailTool(name, args, { source: "chat" });
    }
    if (WIKI_TOOL_SET.has(name)) {
        return runWikiTool(name, args);
    }
    if (await isCrawl4AIToolName(name)) {
        return runCrawl4AIToolOrchestrated({
            name,
            args,
            conversationId: context?.conversationId ?? null,
            source: "chat",
            userIntent: context?.userIntent ?? null,
            apiKey: context?.apiKey,
            appUrl: context?.appUrl,
            modelLite: context?.modelLite,
        });
    }
    if (PERSONAL_MEMORY_TOOL_SET.has(name)) {
        return runPersonalMemoryTool(name, args, context);
    }
    if (SCRATCHPAD_TOOL_SET.has(name)) {
        return runScratchpadTool(name, args, {
            model: context?.model,
            conversationId: context?.conversationId,
        });
    }
    if (CALENDAR_TOOL_SET.has(name)) {
        return runCalendarTool(name, args);
    }
    if (DOC_TOOL_SET.has(name)) {
        return runDocTool(name, args);
    }
    if (CSV_TOOL_SET.has(name)) {
        return runCsvTool(name, args);
    }
    if (ARXIV_TOOL_SET.has(name)) {
        return runArxivTool(name, args);
    }
    if (MAPS_TOOL_SET.has(name)) {
        return runMapsTool(name, args);
    }
    if (SYSTEM_TOOL_SET.has(name)) {
        if (name === "system_list_dir") {
            return runDocTool("doc_list_dir", args);
        }
        if (name === "system_read_file") {
            return runDocTool("doc_read_file", args);
        }
    }
    if (USER_TOOL_SET.has(name)) {
        return runUserTool(name, args);
    }
    if (isSSEFProposalTriggerToolName(name)) {
        return runSSEFProposalTriggerTool(name, args, {
            source: "chat",
            conversationId: context?.conversationId ?? null,
            userIntent: context?.userIntent ?? null,
        });
    }
    const ssefResult = await runSSEFToolByName(name, args, {
        source: "chat",
        conversationId: context?.conversationId ?? null,
        userIntent: context?.userIntent ?? null,
    });
    if (ssefResult) {
        return ssefResult;
    }
    throw new Error(`Unknown tool: ${name}`);
}
