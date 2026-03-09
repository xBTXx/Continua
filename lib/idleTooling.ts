import { type ToolDefinition } from "./openrouter";
import {
  emailToolsEnabled,
  getEmailAccountHints,
  getEmailToolDefinitions,
  runEmailTool,
  EMAIL_TOOL_NAMES,
} from "./emailTools";
import {
  getWikiToolDefinitions,
  runWikiTool,
  wikiToolsEnabled,
  WIKI_TOOL_NAMES,
} from "./wikiTools";
import {
  crawl4aiToolsEnabled,
  getCrawl4AIToolDefinitions,
  isCrawl4AIToolName,
} from "./crawl4aiTools";
import { runCrawl4AIToolOrchestrated } from "./crawl4aiOrchestrator";
import {
  calendarToolsEnabled,
  getCalendarToolDefinitions,
  runCalendarTool,
  CALENDAR_TOOL_NAMES,
} from "./calendarTools";
import {
  csvToolsEnabled,
  docToolsEnabled,
  getCsvToolDefinitions,
  getDocToolDefinitions,
  runCsvTool,
  runDocTool,
  CSV_TOOL_NAMES,
  DOC_TOOL_NAMES,
} from "./fileTools";
import {
  arxivToolsEnabled,
  getArxivToolDefinitions,
  runArxivTool,
  ARXIV_TOOL_NAMES,
} from "./arxivTools";
import {
  getSSEFProposalTriggerToolDefinitions,
  isSSEFProposalTriggerToolName,
  runSSEFProposalTriggerTool,
  ssefProposalToolIdleEnabled,
} from "./ssef/proposals/triggerTool";
import { getSSEFConfig } from "./ssef/config";
import { getScratchpadToolDefinitions, runScratchpadTool } from "./scratchpadTools";
import { getActiveSkillToolDefinitions } from "./ssef/runtime/toolDefinitions";
import { runSSEFToolByName } from "./ssef/runtime/adapter";

const IDLE_EMAIL_TOOL_PROMPT_LINES = [
  "You can use email tools to read, draft, and send messages during idle time.",
  "You may act autonomously, but avoid spam, duplication, or low-confidence outreach.",
  "Use list_accounts if you need account ids; otherwise omit account_id to use the default.",
  "Never claim to have read or sent email unless you called a tool and saw results.",
  "Prefer create_draft before sending unless the message is short and low-risk.",
  "If list_messages or get_message returns replyStatus, avoid duplicate replies unless explicitly asked.",
  "If a tool returns an error, correct the arguments and retry once.",
];
const IDLE_WIKI_TOOL_PROMPT_LINES = [
  "You can use Wikipedia tools to look up general knowledge.",
  "Use wiki_search to find titles, wiki_summary for concise context, and wiki_page for full extracts.",
  "Never claim to have consulted Wikipedia unless you called a tool and saw results.",
];
const IDLE_CRAWL4AI_TOOL_PROMPT_LINES = [
  "You can use Crawl4AI tools to crawl websites, extract markdown, and gather links.",
  "Prefer focused extraction from specific URLs before running broad recursive crawls.",
  "When continuing work on the same authenticated site, reuse the same session whenever possible.",
  "Use recent artifact summaries for quick follow-ups; recrawl when fresh/live/latest information is requested.",
  "NEVER request 'html' or 'screenshot' as they are too large.",
  "Never claim to have read a page unless you called a Crawl4AI tool and saw results.",
];
const IDLE_CALENDAR_TOOL_PROMPT_LINES = [
  "You can use calendar tools to manage events and notes.",
  "Use list_calendar_events to check the schedule before adding new events.",
  "Events can be one-time or recurring; recurrence uses Europe/Warsaw time.",
  "For recurrence, use recurrence_frequency + recurrence_time (+ recurrence_weekday for weekly).",
  "Event notes should be clear and concise.",
  "Always format dates as ISO 8601 or unambiguous descriptions.",
];
const IDLE_DOC_TOOL_PROMPT_LINES = [
  "You can use doc tools to manage files (create/read/update/move/copy/rename/restore) plus fs_bulk_manager for bulk search, bulk move/copy, and multi-file text replacement.",
  "doc_read_file/doc_list_dir/doc_search/doc_stat can inspect workspace paths, project paths, and absolute system paths.",
  "For paths that start with /, doc tools first try workspace/project paths and then true absolute Linux paths.",
  "Write/edit operations stay workspace-rooted for safety.",
  "For fs_bulk_manager move/copy/replace, preview first with apply=false unless the task clearly calls for execution now.",
  "Deletions move items to a recycle bin for 30 days.",
  "For binary data, use encoding=base64 on read/create/overwrite/append.",
  "For edits, read the file first, then prefer targeted update modes (replace/regex/insert/range).",
  "For structured multi-line code changes, prefer doc_apply_patch with unified diff hunks.",
  "In each @@ hunk, old count must match context+remove lines and new count must match context+add lines.",
  "If doc_apply_patch returns a hunk count mismatch, rebuild the hunk header or use doc_update_file for small edits.",
  "Use append only when the user explicitly asks to add content at the end.",
  "For large searches, prefer mode=name or limit content search via extensions/max_file_bytes.",
];
const IDLE_CSV_TOOL_PROMPT_LINES = [
  "You can use CSV tools to read, filter, edit, and summarize CSV files.",
  "Use doc tools for folder operations or deleting files.",
];
const IDLE_ARXIV_TOOL_PROMPT_LINES = [
  "You can use arXiv tools to search and retrieve academic papers.",
  "Use arxiv_search to find IDs, then arxiv_fetch to convert and save Markdown files in the workspace.",
  "Never claim to have fetched a paper unless you called a tool and saw results.",
];
const IDLE_SCRATCHPAD_PROMPT_LINES = [
  "Use save_note to jot a one-cycle scratchpad note that surfaces in the next conversation only.",
  "Review scratchpad notes in context before adding new ones to avoid duplicates.",
];
const IDLE_SSEF_TOOL_PROMPT_LINES = [
  "If dynamic SSEF skill tools are available, treat them like regular tools and call them only when their name/description matches the task.",
  "Only a relevance-selected subset of SSEF skills may be loaded each cycle to protect context budget.",
];
const IDLE_SSEF_PROPOSAL_TOOL_PROMPT_LINES = [
  "If ssef_propose_skill is enabled, use it only for clear capability gaps and provide concrete problem/outcome details.",
  "Include skill_name when the requester provides a preferred name.",
];

const EMAIL_TOOL_SET = new Set<string>(EMAIL_TOOL_NAMES);
const WIKI_TOOL_SET = new Set<string>(WIKI_TOOL_NAMES);
const CALENDAR_TOOL_SET = new Set<string>(CALENDAR_TOOL_NAMES);
const DOC_TOOL_SET = new Set<string>(DOC_TOOL_NAMES);
const CSV_TOOL_SET = new Set<string>(CSV_TOOL_NAMES);
const ARXIV_TOOL_SET = new Set<string>(ARXIV_TOOL_NAMES);
const IDLE_SCRATCHPAD_TOOL_SET = new Set(["save_note"]);

type IdleEmailToolName = (typeof EMAIL_TOOL_NAMES)[number];
type IdleWikiToolName = (typeof WIKI_TOOL_NAMES)[number];
type IdleCalendarToolName = (typeof CALENDAR_TOOL_NAMES)[number];
type IdleDocToolName = (typeof DOC_TOOL_NAMES)[number];
type IdleCsvToolName = (typeof CSV_TOOL_NAMES)[number];
type IdleArxivToolName = (typeof ARXIV_TOOL_NAMES)[number];

export const LOGGED_EMAIL_TOOLS = new Set([
  "create_draft",
  "send_message",
  "reply",
]);

function asStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

export function buildEmailActionContent(name: string, args: Record<string, unknown>) {
  const to = asStringArray(args.to).join(", ");
  const cc = asStringArray(args.cc).join(", ");
  const bcc = asStringArray(args.bcc).join(", ");
  const subject = typeof args.subject === "string" ? args.subject.trim() : "";
  const messageId =
    typeof args.message_id === "string" ? args.message_id.trim() : "";
  const replyTo =
    typeof args.reply_to_message_id === "string"
      ? args.reply_to_message_id.trim()
      : "";

  const parts: string[] = [];
  if (to) {
    parts.push(`to ${to}`);
  }
  if (cc) {
    parts.push(`cc ${cc}`);
  }
  if (bcc) {
    parts.push(`bcc ${bcc}`);
  }
  if (subject) {
    parts.push(`subject "${subject}"`);
  }
  if (replyTo) {
    parts.push(`reply to ${replyTo}`);
  }
  if (messageId && !replyTo) {
    parts.push(`message ${messageId}`);
  }

  if (parts.length === 0) {
    return name;
  }
  return parts.join(", ");
}

export function buildIdleToolInstructions() {
  const lines: string[] = [];
  lines.push(...IDLE_SCRATCHPAD_PROMPT_LINES);
  if (emailToolsEnabled()) {
    lines.push(...IDLE_EMAIL_TOOL_PROMPT_LINES);
    const accountHints = getEmailAccountHints();
    if (accountHints.length > 0) {
      const accountLines = accountHints.map(
        (account) =>
          `- ${account.id}: ${account.email} (${account.type})` +
          (account.displayName ? ` [${account.displayName}]` : "")
      );
      lines.push("Configured accounts:", ...accountLines);
    }
  }
  if (wikiToolsEnabled()) {
    lines.push(...IDLE_WIKI_TOOL_PROMPT_LINES);
  }
  if (crawl4aiToolsEnabled()) {
    lines.push(...IDLE_CRAWL4AI_TOOL_PROMPT_LINES);
  }
  if (calendarToolsEnabled()) {
    lines.push(...IDLE_CALENDAR_TOOL_PROMPT_LINES);
  }
  if (docToolsEnabled()) {
    lines.push(...IDLE_DOC_TOOL_PROMPT_LINES);
  }
  if (csvToolsEnabled()) {
    lines.push(...IDLE_CSV_TOOL_PROMPT_LINES);
  }
  if (arxivToolsEnabled()) {
    lines.push(...IDLE_ARXIV_TOOL_PROMPT_LINES);
  }
  if (ssefProposalToolIdleEnabled()) {
    lines.push(...IDLE_SSEF_PROPOSAL_TOOL_PROMPT_LINES);
  }
  lines.push(...IDLE_SSEF_TOOL_PROMPT_LINES);
  return lines.join("\n");
}

export async function getIdleToolDefinitions(): Promise<ToolDefinition[]> {
  let ssefConfig: ReturnType<typeof getSSEFConfig> | null = null;
  try {
    ssefConfig = getSSEFConfig();
  } catch {
    ssefConfig = null;
  }
  const scratchpadTools = getScratchpadToolDefinitions().filter(
    (tool) => tool.function.name === "save_note"
  ).map((tool) => ({
    ...tool,
    function: {
      ...tool.function,
      description:
        "Save a temporary scratchpad note that surfaces in the next active conversation.",
    },
  }));
  const emailTools = getEmailToolDefinitions();
  const wikiTools = getWikiToolDefinitions();
  const crawl4aiTools = await getCrawl4AIToolDefinitions();
  const calendarTools = getCalendarToolDefinitions();
  const docTools = getDocToolDefinitions();
  const csvTools = getCsvToolDefinitions();
  const arxivTools = getArxivToolDefinitions();
  const proposalTools = ssefProposalToolIdleEnabled()
    ? getSSEFProposalTriggerToolDefinitions()
    : [];
  const rawSSEFTools = await getActiveSkillToolDefinitions({
    maxTools: ssefConfig?.runtimeSelection.idleMaxTools,
    minScore: ssefConfig?.runtimeSelection.minScore,
    maxQueryTokens: ssefConfig?.runtimeSelection.maxQueryTokens,
  });
  const staticNameSet = new Set<string>([
    ...scratchpadTools,
    ...emailTools,
    ...wikiTools,
    ...crawl4aiTools,
    ...calendarTools,
    ...docTools,
    ...csvTools,
    ...arxivTools,
    ...proposalTools,
  ].map((tool) => tool.function.name));
  const ssefTools = rawSSEFTools.filter(
    (tool) => !staticNameSet.has(tool.function.name)
  );
  return [
    ...scratchpadTools,
    ...emailTools,
    ...wikiTools,
    ...crawl4aiTools,
    ...calendarTools,
    ...docTools,
    ...csvTools,
    ...arxivTools,
    ...proposalTools,
    ...ssefTools,
  ];
}

export async function runIdleTool(
  name: string,
  args: Record<string, unknown>,
  context?: {
    sessionScopeId?: string | null;
    userIntent?: string | null;
    modelLite?: string | null;
  }
) {
  if (IDLE_SCRATCHPAD_TOOL_SET.has(name)) {
    return runScratchpadTool(name, args, { source: "idle_state" });
  }
  if (EMAIL_TOOL_SET.has(name)) {
    return runEmailTool(name as IdleEmailToolName, args, { source: "idle" });
  }
  if (WIKI_TOOL_SET.has(name)) {
    return runWikiTool(name as IdleWikiToolName, args);
  }
  if (await isCrawl4AIToolName(name)) {
    return runCrawl4AIToolOrchestrated({
      name,
      args,
      conversationId: context?.sessionScopeId ?? null,
      source: "idle",
      userIntent: context?.userIntent ?? null,
      modelLite: context?.modelLite ?? null,
    });
  }
  if (CALENDAR_TOOL_SET.has(name)) {
    return runCalendarTool(name as IdleCalendarToolName, args);
  }
  if (DOC_TOOL_SET.has(name)) {
    return runDocTool(name as IdleDocToolName, args);
  }
  if (CSV_TOOL_SET.has(name)) {
    return runCsvTool(name as IdleCsvToolName, args);
  }
  if (ARXIV_TOOL_SET.has(name)) {
    return runArxivTool(name as IdleArxivToolName, args);
  }
  if (name === "system_list_dir") {
    return runDocTool("doc_list_dir", args);
  }
  if (name === "system_read_file") {
    return runDocTool("doc_read_file", args);
  }
  if (isSSEFProposalTriggerToolName(name)) {
    return runSSEFProposalTriggerTool(name, args, {
      source: "idle",
      sessionScopeId: context?.sessionScopeId ?? null,
      userIntent: context?.userIntent ?? null,
    });
  }
  const ssefResult = await runSSEFToolByName(name, args, {
    source: "idle",
    sessionScopeId: context?.sessionScopeId ?? null,
    userIntent: context?.userIntent ?? null,
  });
  if (ssefResult) {
    return ssefResult;
  }
  throw new Error(`Unknown idle tool: ${name}`);
}
