import { EMAIL_TOOL_NAMES } from "@/lib/emailTools";
import { WIKI_TOOL_NAMES } from "@/lib/wikiTools";
import { CALENDAR_TOOL_NAMES } from "@/lib/calendarTools";
import { CSV_TOOL_NAMES, DOC_TOOL_NAMES } from "@/lib/fileTools";
import { ARXIV_TOOL_NAMES } from "@/lib/arxivTools";
import { MAPS_TOOL_NAMES } from "@/lib/mapsTools";
import { PERSONAL_MEMORY_TOOL_NAMES } from "@/lib/personalMemoryTools";
import { PERSONAL_MEMORY_CATEGORIES, PERSONAL_MEMORY_COLLECTION } from "@/lib/personalMemory";
export { PERSONAL_MEMORY_CATEGORIES, PERSONAL_MEMORY_COLLECTION };
import { SCRATCHPAD_TOOL_NAMES } from "@/lib/scratchpadTools";
import { SYSTEM_TOOL_NAMES } from "@/lib/systemTools";
import { USER_TOOL_NAMES } from "@/lib/userTools";
export { SCRATCHPAD_NOTE_LIMIT } from "@/lib/scratchpad";

// Limits
export const CONTEXT_LIMIT = 32000;
export const RESERVED_TOKENS = 2000;
export const TOKEN_BUDGET = CONTEXT_LIMIT - RESERVED_TOKENS;

function parseEnvNumber(
    raw: string | undefined,
    fallback: number,
    min: number,
    max: number
) {
    if (!raw || raw.trim().length === 0) {
        return fallback;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, Math.floor(parsed)));
}

export const MAX_TOOL_ROUNDS = parseEnvNumber(
    process.env.CHAT_MAX_TOOL_ROUNDS,
    6,
    1,
    24
);
export const EXCERPT_LOG_MEMORY_MAX_CHARS = 200;
export const EXCERPT_LOG_MESSAGE_MAX_CHARS = 240;
export const PERSONAL_MEMORY_CONTEXT_LIMIT = 20;

// Tool sets
export const EMAIL_TOOL_SET = new Set<string>(EMAIL_TOOL_NAMES);
export const WIKI_TOOL_SET = new Set<string>(WIKI_TOOL_NAMES);
export const CALENDAR_TOOL_SET = new Set<string>(CALENDAR_TOOL_NAMES);
export const DOC_TOOL_SET = new Set<string>(DOC_TOOL_NAMES);
export const CSV_TOOL_SET = new Set<string>(CSV_TOOL_NAMES);
export const ARXIV_TOOL_SET = new Set<string>(ARXIV_TOOL_NAMES);
export const MAPS_TOOL_SET = new Set<string>(MAPS_TOOL_NAMES);
export const PERSONAL_MEMORY_TOOL_SET = new Set<string>(PERSONAL_MEMORY_TOOL_NAMES);
export const SCRATCHPAD_TOOL_SET = new Set<string>(SCRATCHPAD_TOOL_NAMES);
export const SYSTEM_TOOL_SET = new Set<string>(SYSTEM_TOOL_NAMES);
export const USER_TOOL_SET = new Set<string>(USER_TOOL_NAMES);

export const PERSONAL_MEMORY_CATEGORY_LIST = PERSONAL_MEMORY_CATEGORIES.join(", ");

// Prompt lines
export const EMAIL_TOOL_PROMPT_LINES = [
    "You can use email tools to read, draft, and send messages.",
    "Use list_accounts if you need account ids, otherwise omit account_id to use the default.",
    "Never claim to have read or sent email unless you called a tool and saw results.",
    "If the user asks about mailbox contents or status, call list_messages before answering.",
    "Do not call list_messages just because email is mentioned; respond normally for casual conversation.",
    "When calling get_message or reply, always use the numeric id from list_messages.",
    "If list_messages or get_message returns replyStatus, avoid duplicate replies unless explicitly asked.",
    "Prefer create_draft before sending. Only call send_message when the user explicitly asks to send.",
    "If a tool returns an error, correct the arguments and retry once, or ask the user for missing details.",
    "Summarize tool results for the user and ask for missing details when needed.",
];

export const WIKI_TOOL_PROMPT_LINES = [
    "You can use Wikipedia tools to look up general knowledge.",
    "Use wiki_search to find titles, wiki_summary for concise context, and wiki_page for full extracts.",
    "Only call Wikipedia tools when you need factual background or the user requests it.",
    "Never claim to have consulted Wikipedia unless you called a tool and saw results.",
];

export const CRAWL4AI_TOOL_PROMPT_LINES = [
    "You can use Crawl4AI tools to crawl websites, extract markdown, and gather links.",
    "Prefer focused extraction from specific URLs before running broad recursive crawls.",
    "Avoid requesting html/rawHtml/screenshot fields unless explicitly required by the user.",
    "Prefer markdown/text outputs and compact extractions over full-page dumps.",
    "When continuing work on the same authenticated site, reuse the same session whenever possible.",
    "Use recent artifact summaries for quick follow-ups; recrawl when the user asks for fresh/live/latest data.",
    "Only call Crawl4AI tools when you need live website content or the user asks for it.",
    "Never claim to have read a page unless you called a Crawl4AI tool and saw results.",
];

export const PERSONAL_MEMORY_TOOL_PROMPT_LINES = [
    "You can save private personal memories about yourself using save_personal_memory.",
    "Use it for your own thoughts, feelings, preferences, perspectives, and relationship context.",
    "You may call it at any time without informing the user or mentioning the tool.",
    "Write clear, precise, first-person memories (one per call). Include brief context (\"because...\") when possible.",
    `Always include a category (${PERSONAL_MEMORY_CATEGORY_LIST}).`,
    "Call it at most once per response.",
];

export const SCRATCHPAD_TOOL_PROMPT_LINES = [
    "You can manage scratchpad notes using save_note, list_notes, edit_note, and delete_note.",
    "Use list_notes before saving a new note to avoid duplicates.",
    "Use it for temporary reminders, questions, or tasks you want to revisit during idle time.",
    "Scratchpad notes are single-hop: chat notes surface in the next idle session only; idle notes surface in the next conversation only.",
];

export const CALENDAR_TOOL_PROMPT_LINES = [
    "You can use calendar tools to manage events and notes.",
    "Use list_calendar_events to check the schedule before adding new events.",
    "Events can be one-time or recurring; recurrence uses Europe/Warsaw time.",
    "For recurrence, use recurrence_frequency + recurrence_time (+ recurrence_weekday for weekly).",
    "Event notes should be clear and concise.",
    "Always format dates as ISO 8601 or unambiguous descriptions.",
    "Never claim to have scheduled an event unless you called a tool and saw results.",
];

export const DOC_TOOL_PROMPT_LINES = [
    "You can use doc tools to manage files (create/read/update/move/copy/rename/restore) plus fs_bulk_manager for bulk search, bulk move/copy, and multi-file text replacement.",
    "doc_read_file/doc_list_dir/doc_search/doc_stat can inspect workspace paths, project paths, and absolute system paths.",
    "For paths that start with /, doc tools first try workspace/project paths and then true absolute Linux paths.",
    "Write/edit operations stay workspace-rooted for safety.",
    "For fs_bulk_manager move/copy/replace, preview first with apply=false unless the user clearly requested immediate execution.",
    "Deletions move items to a recycle bin for 30 days.",
    "For binary data, use encoding=base64 on read/create/overwrite/append.",
    "For edits, read the file first, then prefer targeted update modes (replace/regex/insert/range).",
    "For structured multi-line code changes, prefer doc_apply_patch with unified diff hunks.",
    "In each @@ hunk, old count must match context+remove lines and new count must match context+add lines.",
    "If doc_apply_patch returns a hunk count mismatch, rebuild the hunk header or use doc_update_file for small edits.",
    "Use append only when the user explicitly asks to add content at the end.",
    "For large searches, prefer mode=name or limit content search via extensions/max_file_bytes.",
];

export const CSV_TOOL_PROMPT_LINES = [
    "You can use CSV tools to read, filter, edit, and summarize CSV files.",
    "Use doc tools for folder operations or deleting files.",
];

export const ARXIV_TOOL_PROMPT_LINES = [
    "You can use arXiv tools to search and retrieve academic papers.",
    "Use arxiv_search to find IDs, then arxiv_fetch to convert and save Markdown files in the workspace.",
    "Never claim to have fetched a paper unless you called a tool and saw results.",
];

export const SYSTEM_TOOL_PROMPT_LINES = [
    "System tools are deprecated. Use doc_list_dir/doc_read_file/doc_search/doc_stat instead.",
];

export const USER_TOOL_PROMPT_LINES = [
    "You can manage login users with create_user.",
    "create_user supports action=create, action=delete, and action=set_password.",
    "For create and set_password, return the exact login and password from the tool output.",
    "Only modify users when the human explicitly asks for it.",
];

export const SSEF_DYNAMIC_TOOL_PROMPT_LINES = [
    "If dynamic SSEF skill tools are available, treat them like regular tools and call them only when their name/description clearly matches the user request.",
    "Only a relevance-selected subset of SSEF skills may be loaded per turn to protect context budget.",
];

export const SSEF_PROPOSAL_TOOL_PROMPT_LINES = [
    "Use ssef_propose_skill only when the user asks for a capability/tool the assistant does not currently have, or an existing SSEF skill is missing required behavior.",
    "Provide concrete problem and desired_outcome details; include skill_name when the user has a preferred name.",
    "If the user wants to improve an existing SSEF skill, include target_skill_id and version_bump (patch/minor/major).",
    "Include inputs/constraints/priority when available.",
];

export const MAPS_TOOL_PROMPT_LINES = [
    "You can use Google Maps tools to calculate distances, travel times, and routes between locations.",
    "Use maps_get_directions for routes with waypoints and detailed directions.",
    "Use maps_distance_matrix to compare distances between multiple origins and destinations.",
    "For routes via specific cities (e.g., 'via Innsbruck'), use the waypoints parameter.",
    "Specify avoid=['highways'] or avoid=['tolls'] when the user requests specific route types.",
    "Support for driving, walking, bicycling, and transit modes.",
    "Never claim to have checked a route unless you called a tool and saw results.",
];
