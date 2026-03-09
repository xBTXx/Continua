"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { withBasePath } from "@/lib/basePath";

type WorkspaceSessionItem = {
  id: string;
  thoughtText: string;
  seedId: string;
  seedSource: string;
  status: string;
  model?: string | null;
  finalThought?: string | null;
  summary?: string | null;
  createdAt: string;
  updatedAt: string;
};

type WorkspaceEventItem = {
  id: string;
  sessionId: string;
  eventType: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
};

type SessionResponse = {
  total: number;
  items: WorkspaceSessionItem[];
};

type EventsResponse = {
  items: WorkspaceEventItem[];
};

type StepGroup = {
  id: string;
  step: number | null;
  label: string;
  events: WorkspaceEventItem[];
  startedAt: string;
  endedAt: string;
  toolCalls: number;
  errors: number;
};

type EventSection = {
  id: string;
  title: string;
  preview?: string;
  kind: "text" | "kv" | "json" | "memory";
  value: unknown;
  defaultOpen?: boolean;
};

type MemorySummaryItem = {
  content?: string;
  [key: string]: unknown;
};

type MemorySummary = {
  count?: number;
  items?: MemorySummaryItem[];
};

const SESSION_LIMIT = 25;
const EVENT_LIMIT = 150;
const REFRESH_MS = 4000;

function formatDate(raw: string) {
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return raw;
  }
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatLabel(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function toStepNumber(payload: Record<string, unknown> | null) {
  if (!payload) {
    return null;
  }
  const raw = payload.step;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === "string") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function normalizeText(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMemorySummary(value: unknown): value is MemorySummary {
  if (!isRecord(value)) {
    return false;
  }
  if (!Array.isArray(value.items)) {
    return false;
  }
  return true;
}

function safeStringify(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "[unserializable]";
  }
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return value;
    }
  }

  return value;
}

function formatInlineValue(value: unknown) {
  if (value === null || typeof value === "undefined") {
    return "--";
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || "--";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const primitives = value.filter(
      (entry) => ["string", "number", "boolean"].includes(typeof entry)
    );
    if (primitives.length === value.length) {
      return primitives.map((entry) => String(entry)).join(", ") || "--";
    }
  }
  return safeStringify(value);
}

function buildStepLabel(step: number | null, eventType: string) {
  if (typeof step === "number") {
    return `Step ${step + 1}`;
  }
  if (eventType === "start") {
    return "Session Start";
  }
  if (eventType === "exit") {
    return "Session Wrap-Up";
  }
  return "Session Event";
}

function eventTone(eventType: string) {
  switch (eventType) {
    case "error":
      return "border-red-200 bg-red-50 text-red-700";
    case "tool_call":
      return "border-sky-200 bg-sky-50 text-sky-700";
    case "tool_result":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "memory_context":
      return "border-amber-200 bg-amber-50 text-amber-700";
    default:
      return "border-black/10 bg-[rgba(12,23,40,0.05)] text-[var(--muted)]";
  }
}

function getToolInput(payload: Record<string, unknown>) {
  const prioritized = payload.args_json ?? payload.args;
  if (typeof prioritized === "undefined") {
    return null;
  }
  return parseMaybeJson(prioritized);
}

function omitPayloadKeys(
  payload: Record<string, unknown>,
  keys: string[]
): Record<string, unknown> {
  const omitted = new Set(keys);
  const next: Record<string, unknown> = {};
  Object.entries(payload).forEach(([key, value]) => {
    if (omitted.has(key)) {
      return;
    }
    next[key] = value;
  });
  return next;
}

function buildEventHeadline(event: WorkspaceEventItem) {
  const payload = event.payload;
  const label = formatLabel(event.eventType);
  if (!payload) {
    return label;
  }

  if (event.eventType === "tool_call") {
    const tool = normalizeText(payload.tool);
    return tool ? `Tool Call: ${tool}` : label;
  }

  if (event.eventType === "tool_result") {
    const tool = normalizeText(payload.tool);
    return tool ? `Tool Result: ${tool}` : label;
  }

  if (event.eventType === "note") {
    const content = normalizeText(payload.content);
    return content ? `Thought: ${content.slice(0, 78)}` : label;
  }

  if (event.eventType === "start") {
    const thought = normalizeText(payload.thought);
    return thought ? `Trigger: ${thought.slice(0, 78)}` : label;
  }

  if (event.eventType === "error") {
    const message = normalizeText(payload.message);
    return message ? `Error: ${message.slice(0, 78)}` : label;
  }

  return label;
}

function buildEventSections(event: WorkspaceEventItem): EventSection[] {
  const payload = event.payload;
  if (!payload) {
    return [];
  }

  if (event.eventType === "start") {
    const sections: EventSection[] = [];

    const thought = normalizeText(payload.thought);
    if (thought) {
      sections.push({
        id: "trigger-thought",
        title: "Trigger Thought",
        preview: thought,
        kind: "text",
        value: thought,
        defaultOpen: true,
      });
    }

    const seedMeta = {
      seed_id: payload.seed_id,
      seed_source: payload.seed_source,
    };
    sections.push({
      id: "seed-meta",
      title: "Seed",
      kind: "kv",
      value: seedMeta,
      defaultOpen: true,
    });

    const seedExcerpt = normalizeText(payload.seed_excerpt);
    if (seedExcerpt) {
      sections.push({
        id: "seed-excerpt",
        title: "Seed Excerpt",
        preview: seedExcerpt,
        kind: "text",
        value: seedExcerpt,
      });
    }

    const remainder = omitPayloadKeys(payload, [
      "thought",
      "seed_id",
      "seed_source",
      "seed_excerpt",
    ]);
    if (Object.keys(remainder).length > 0) {
      sections.push({
        id: "start-raw",
        title: "Raw Payload",
        kind: "json",
        value: remainder,
      });
    }

    return sections;
  }

  if (event.eventType === "note") {
    const content = normalizeText(payload.content);
    const sections: EventSection[] = [];

    if (content) {
      sections.push({
        id: "assistant-note",
        title: "Assistant Note",
        preview: content,
        kind: "text",
        value: content,
        defaultOpen: true,
      });
    }

    const remainder = omitPayloadKeys(payload, ["content", "step"]);
    if (Object.keys(remainder).length > 0) {
      sections.push({
        id: "note-meta",
        title: "Metadata",
        kind: "kv",
        value: remainder,
      });
    }

    return sections;
  }

  if (event.eventType === "memory_context") {
    const sections: EventSection[] = [];
    const queryBlock = {
      queries: payload.queries,
      personal_queries: payload.personal_queries,
      resonance_queries: payload.resonance_queries,
      resonance_tags: payload.resonance_tags,
    };

    sections.push({
      id: "queries",
      title: "Retrieval Queries",
      kind: "kv",
      value: queryBlock,
      defaultOpen: true,
    });

    sections.push({
      id: "memory-stats",
      title: "Retrieval Stats",
      kind: "kv",
      value: {
        resonance_weight: payload.resonance_weight,
        resonant_count: payload.resonant_count,
        temporal_count: payload.temporal_count,
        personal_resonant_count: payload.personal_resonant_count,
        personal_temporal_count: payload.personal_temporal_count,
      },
    });

    if (isMemorySummary(payload.memories)) {
      sections.push({
        id: "main-memories",
        title: "Main Memory Candidates",
        kind: "memory",
        value: payload.memories,
      });
    }

    if (isMemorySummary(payload.personal_memories)) {
      sections.push({
        id: "personal-memories",
        title: "Personal Memory Candidates",
        kind: "memory",
        value: payload.personal_memories,
      });
    }

    if (isMemorySummary(payload.injected_memories)) {
      sections.push({
        id: "injected-main-memories",
        title: "Injected Main Memories",
        kind: "memory",
        value: payload.injected_memories,
      });
    }

    if (isMemorySummary(payload.injected_personal_memories)) {
      sections.push({
        id: "injected-personal-memories",
        title: "Injected Personal Memories",
        kind: "memory",
        value: payload.injected_personal_memories,
      });
    }

    const remainder = omitPayloadKeys(payload, [
      "step",
      "queries",
      "personal_queries",
      "resonance_queries",
      "resonance_tags",
      "resonance_weight",
      "resonant_count",
      "temporal_count",
      "personal_resonant_count",
      "personal_temporal_count",
      "memories",
      "personal_memories",
      "injected_memories",
      "injected_personal_memories",
    ]);
    if (Object.keys(remainder).length > 0) {
      sections.push({
        id: "memory-raw",
        title: "Raw Payload",
        kind: "json",
        value: remainder,
      });
    }

    return sections;
  }

  if (event.eventType === "tool_call") {
    const sections: EventSection[] = [];
    const inputPayload = getToolInput(payload);
    const rawInput = parseMaybeJson(payload.args_raw);

    sections.push({
      id: "tool-meta",
      title: "Tool Metadata",
      kind: "kv",
      value: {
        tool: payload.tool,
        web_domain: payload.web_domain,
      },
      defaultOpen: true,
    });

    if (inputPayload !== null) {
      sections.push({
        id: "tool-input",
        title: "Tool Input Payload",
        preview: typeof inputPayload === "string" ? inputPayload : undefined,
        kind: isRecord(inputPayload) || Array.isArray(inputPayload) ? "json" : "text",
        value: inputPayload,
        defaultOpen: true,
      });
    }

    if (typeof rawInput === "string" && rawInput.trim()) {
      sections.push({
        id: "tool-input-raw",
        title: "Raw Tool Arguments",
        preview: rawInput,
        kind: "text",
        value: rawInput,
      });
    }

    const remainder = omitPayloadKeys(payload, [
      "step",
      "tool",
      "web_domain",
      "args",
      "args_json",
      "args_raw",
    ]);
    if (Object.keys(remainder).length > 0) {
      sections.push({
        id: "tool-call-raw",
        title: "Raw Payload",
        kind: "json",
        value: remainder,
      });
    }

    return sections;
  }

  if (event.eventType === "tool_result") {
    const sections: EventSection[] = [];
    const summary = parseMaybeJson(payload.summary);

    sections.push({
      id: "tool-result-meta",
      title: "Result Metadata",
      kind: "kv",
      value: {
        tool: payload.tool,
        ok: payload.ok,
      },
      defaultOpen: true,
    });

    if (summary) {
      sections.push({
        id: "tool-result-summary",
        title: "Result Summary",
        preview: typeof summary === "string" ? summary : undefined,
        kind: isRecord(summary) || Array.isArray(summary) ? "json" : "text",
        value: summary,
      });
    }

    if (isRecord(payload.web) || Array.isArray(payload.web)) {
      sections.push({
        id: "tool-result-web",
        title: "Web Metadata",
        kind: "json",
        value: payload.web,
      });
    }

    const remainder = omitPayloadKeys(payload, ["step", "tool", "ok", "summary", "web"]);
    if (Object.keys(remainder).length > 0) {
      sections.push({
        id: "tool-result-raw",
        title: "Raw Payload",
        kind: "json",
        value: remainder,
      });
    }

    return sections;
  }

  if (event.eventType === "exit") {
    const sections: EventSection[] = [];

    const finalThought = normalizeText(payload.final_thought);
    if (finalThought) {
      sections.push({
        id: "exit-final-thought",
        title: "Final Thought",
        preview: finalThought,
        kind: "text",
        value: finalThought,
        defaultOpen: true,
      });
    }

    const summary = normalizeText(payload.summary);
    if (summary) {
      sections.push({
        id: "exit-summary",
        title: "Session Summary",
        preview: summary,
        kind: "text",
        value: summary,
      });
    }

    sections.push({
      id: "exit-stats",
      title: "Exit Metadata",
      kind: "kv",
      value: {
        actions_count: payload.actions_count,
      },
    });

    const remainder = omitPayloadKeys(payload, [
      "step",
      "summary",
      "final_thought",
      "actions_count",
    ]);
    if (Object.keys(remainder).length > 0) {
      sections.push({
        id: "exit-raw",
        title: "Raw Payload",
        kind: "json",
        value: remainder,
      });
    }

    return sections;
  }

  if (event.eventType === "error") {
    const sections: EventSection[] = [];
    const message = normalizeText(payload.message);
    if (message) {
      sections.push({
        id: "error-message",
        title: "Error Message",
        preview: message,
        kind: "text",
        value: message,
        defaultOpen: true,
      });
    }

    const remainder = omitPayloadKeys(payload, ["message", "step"]);
    if (Object.keys(remainder).length > 0) {
      sections.push({
        id: "error-meta",
        title: "Metadata",
        kind: "kv",
        value: remainder,
      });
    }

    return sections;
  }

  return [
    {
      id: "raw",
      title: "Payload",
      kind: "json",
      value: payload,
      defaultOpen: true,
    },
  ];
}

function KeyValueGrid({ value }: { value: unknown }) {
  if (!isRecord(value)) {
    return <JsonBlock value={value} />;
  }

  const entries = Object.entries(value).filter(([, entry]) => {
    if (entry === null || typeof entry === "undefined") {
      return false;
    }
    if (typeof entry === "string") {
      return entry.trim().length > 0;
    }
    return true;
  });

  if (entries.length === 0) {
    return <p className="text-xs text-[var(--muted)]">No fields recorded.</p>;
  }

  return (
    <dl className="grid gap-2 sm:grid-cols-2">
      {entries.map(([key, entry]) => (
        <div
          key={key}
          className="rounded-xl border border-black/10 bg-white px-3 py-2 text-xs"
        >
          <dt className="mb-1 uppercase tracking-[0.18em] text-[var(--muted)]">
            {formatLabel(key)}
          </dt>
          <dd className="whitespace-pre-wrap break-words text-[13px] text-[var(--ink)]">
            {formatInlineValue(entry)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-xl border border-black/10 bg-[rgba(12,23,40,0.04)] px-3 py-2 text-xs text-[var(--ink)] [overflow-wrap:anywhere]">
      {safeStringify(value)}
    </pre>
  );
}

function MemorySummaryBlock({ value }: { value: unknown }) {
  if (!isMemorySummary(value)) {
    return <JsonBlock value={value} />;
  }

  const count = typeof value.count === "number" ? value.count : value.items?.length ?? 0;
  const items = Array.isArray(value.items) ? value.items : [];

  return (
    <div className="grid gap-2">
      <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
        {count} memories
      </p>
      {items.length === 0 && (
        <p className="rounded-xl border border-black/10 bg-white px-3 py-2 text-xs text-[var(--muted)]">
          No memory items.
        </p>
      )}
      {items.map((item, index) => {
        const record = isRecord(item) ? item : null;
        const content = normalizeText(record?.content);
        const metadata = record ? omitPayloadKeys(record, ["content"]) : {};
        return (
          <div
            key={`${index}-${content ?? "memory"}`}
            className="rounded-xl border border-black/10 bg-white px-3 py-2"
          >
            {content && (
              <p className="whitespace-pre-wrap break-words text-sm text-[var(--ink)]">
                {content}
              </p>
            )}
            {Object.keys(metadata).length > 0 && (
              <div className={content ? "mt-2" : ""}>
                <KeyValueGrid value={metadata} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function EventSectionBlock({ section }: { section: EventSection }) {
  const summaryText = section.preview ? section.preview.slice(0, 90) : "";

  const renderSectionContent = (): ReactNode => {
    if (section.kind === "text") {
      return (
        <p className="whitespace-pre-wrap break-words text-sm text-[var(--ink)]">
          {typeof section.value === "string" ? section.value : formatInlineValue(section.value)}
        </p>
      );
    }
    if (section.kind === "kv") {
      return <KeyValueGrid value={section.value} />;
    }
    if (section.kind === "memory") {
      return <MemorySummaryBlock value={section.value} />;
    }
    return <JsonBlock value={section.value} />;
  };

  return (
    <details
      className="group rounded-xl border border-black/10 bg-[rgba(12,23,40,0.03)]"
      open={section.defaultOpen}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2">
        <span className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
          {section.title}
        </span>
        <span className="max-w-[260px] truncate text-[11px] text-[var(--muted)]">
          {summaryText || "expand"}
        </span>
      </summary>
      <div className="px-3 pb-3">{renderSectionContent()}</div>
    </details>
  );
}

function renderEventMetaPills(event: WorkspaceEventItem) {
  const payload = event.payload;
  const items: string[] = [];
  if (payload) {
    if (typeof payload.tool === "string") {
      items.push(payload.tool);
    }
    if (typeof payload.ok === "boolean") {
      items.push(payload.ok ? "ok" : "failed");
    }
    const step = toStepNumber(payload);
    if (typeof step === "number") {
      items.push(`step ${step + 1}`);
    }
  }

  return items;
}

async function fetchSessions(): Promise<SessionResponse> {
  const response = await fetch(
    withBasePath(`/api/idle-workspace/sessions?limit=${SESSION_LIMIT}&offset=0`)
  );
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || "Unable to load workspace sessions.");
  }
  return (await response.json()) as SessionResponse;
}

async function fetchEvents(sessionId: string | null): Promise<EventsResponse> {
  const params = new URLSearchParams({
    limit: EVENT_LIMIT.toString(),
    offset: "0",
  });
  if (sessionId) {
    params.set("sessionId", sessionId);
  }
  const response = await fetch(withBasePath(`/api/idle-workspace/events?${params.toString()}`));
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || "Unable to load workspace events.");
  }
  return (await response.json()) as EventsResponse;
}

export default function IdleWorkspacePage() {
  const [sessions, setSessions] = useState<WorkspaceSessionItem[]>([]);
  const [events, setEvents] = useState<WorkspaceEventItem[]>([]);
  const [total, setTotal] = useState(0);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId) ?? null,
    [sessions, selectedSessionId]
  );

  const orderedEvents = useMemo(() => {
    return [...events].sort((a, b) => {
      const aTime = new Date(a.createdAt).getTime();
      const bTime = new Date(b.createdAt).getTime();
      return aTime - bTime;
    });
  }, [events]);

  const stepGroups = useMemo(() => {
    const groups: StepGroup[] = [];

    orderedEvents.forEach((event, index) => {
      const step = toStepNumber(event.payload);
      const key =
        typeof step === "number"
          ? `step:${step}`
          : event.eventType === "start"
            ? "start"
            : event.eventType === "exit"
              ? "exit"
              : `event:${index}`;

      const existing = groups.find((group) => group.id === key);
      if (existing) {
        existing.events.push(event);
        existing.endedAt = event.createdAt;
        if (event.eventType === "tool_call") {
          existing.toolCalls += 1;
        }
        if (event.eventType === "error") {
          existing.errors += 1;
        }
        return;
      }

      groups.push({
        id: key,
        step,
        label: buildStepLabel(step, event.eventType),
        events: [event],
        startedAt: event.createdAt,
        endedAt: event.createdAt,
        toolCalls: event.eventType === "tool_call" ? 1 : 0,
        errors: event.eventType === "error" ? 1 : 0,
      });
    });

    return groups;
  }, [orderedEvents]);

  const loadData = async (sessionId: string | null) => {
    setIsLoading(true);
    setError(null);
    try {
      const [sessionData, eventData] = await Promise.all([fetchSessions(), fetchEvents(sessionId)]);
      setSessions(sessionData.items);
      setTotal(sessionData.total);
      setEvents(eventData.items);
      if (!sessionId && sessionData.items.length > 0) {
        setSelectedSessionId(sessionData.items[0].id);
      }
    } catch (loadError) {
      const message =
        loadError instanceof Error ? loadError.message : "Unable to load workspace log.";
      setError(message);
      setSessions([]);
      setEvents([]);
      setTotal(0);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadData(selectedSessionId);
    const interval = setInterval(() => {
      void loadData(selectedSessionId);
    }, REFRESH_MS);
    return () => clearInterval(interval);
  }, [selectedSessionId]);

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-[radial-gradient(circle_at_14%_18%,rgba(122,190,255,0.24),transparent_42%),radial-gradient(circle_at_85%_8%,rgba(96,229,210,0.24),transparent_38%),radial-gradient(circle_at_80%_90%,rgba(182,215,255,0.18),transparent_45%),linear-gradient(180deg,#edf3ff_0%,#eaf4ff_50%,#edf8ff_100%)] px-5 py-8 lg:px-10">
      <div className="pointer-events-none absolute -top-28 right-[-12%] h-[360px] w-[360px] rounded-full bg-[radial-gradient(circle,rgba(84,216,197,0.22),transparent_68%)] blur-2xl" />
      <div className="pointer-events-none absolute bottom-[-120px] left-[-140px] h-[320px] w-[320px] rounded-full bg-[radial-gradient(circle,rgba(108,168,255,0.28),transparent_70%)] blur-2xl" />

      <div className="relative mx-auto flex w-full max-w-7xl flex-col gap-6">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-[var(--muted)]">Assistant</p>
            <h1 className="font-display text-3xl text-[var(--ink)]">Workspace Log</h1>
            <p className="text-sm text-[var(--muted)]">
              {isLoading ? "Loading workspace activity..." : `${total} sessions`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href="/idle-actions"
              className="rounded-full border border-black/10 bg-white/70 px-5 py-3 text-xs uppercase tracking-[0.2em] text-[var(--muted)] shadow-[var(--shadow)] backdrop-blur hover:border-[var(--green-400)] hover:text-[var(--ink)]"
            >
              Idle actions
            </Link>
            <Link
              href="/idle-metrics"
              className="rounded-full border border-black/10 bg-white/70 px-5 py-3 text-xs uppercase tracking-[0.2em] text-[var(--muted)] shadow-[var(--shadow)] backdrop-blur hover:border-[var(--green-400)] hover:text-[var(--ink)]"
            >
              Idle metrics
            </Link>
            <Link
              href="/"
              className="rounded-full border border-black/10 bg-white/70 px-5 py-3 text-xs uppercase tracking-[0.2em] text-[var(--muted)] shadow-[var(--shadow)] backdrop-blur hover:border-[var(--green-400)] hover:text-[var(--ink)]"
            >
              Back to chat
            </Link>
          </div>
        </header>

        {error && (
          <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <section className="grid items-start gap-6 xl:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
          <aside className="flex min-w-0 flex-col rounded-[28px] border border-black/10 bg-white/70 p-5 shadow-[var(--shadow)] backdrop-blur">
            <div className="mb-4 flex items-center justify-between">
              <p className="text-xs uppercase tracking-[0.3em] text-[var(--muted)]">Sessions</p>
              <span className="text-xs text-[var(--muted)]">{total}</span>
            </div>

            {isLoading && sessions.length === 0 && (
              <div className="rounded-2xl border border-black/10 bg-white px-4 py-3 text-sm text-[var(--muted)]">
                Loading sessions...
              </div>
            )}

            {!isLoading && sessions.length === 0 && (
              <div className="rounded-2xl border border-black/10 bg-white px-4 py-3 text-sm text-[var(--muted)]">
                No workspace sessions yet.
              </div>
            )}

            <div className="min-w-0 xl:max-h-[76vh] xl:overflow-y-auto xl:pr-1">
              <ul className="grid min-w-0 gap-3">
                {sessions.map((session) => {
                  const active = session.id === selectedSessionId;
                  return (
                    <li key={session.id} className="min-w-0">
                      <button
                        type="button"
                        className={`w-full min-w-0 rounded-2xl border px-4 py-3 text-left text-sm shadow-sm transition ${
                          active
                            ? "border-transparent bg-[var(--green-500)] text-white"
                            : "border-black/10 bg-white text-[var(--ink)] hover:border-[var(--green-400)]"
                        }`}
                        onClick={() => setSelectedSessionId(session.id)}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs uppercase tracking-[0.2em]">
                          <span>{session.status}</span>
                          <span>{formatDate(session.createdAt)}</span>
                        </div>
                        <p className="mt-2 break-words text-sm font-medium">{session.thoughtText}</p>
                        <p className="mt-2 text-[10px] uppercase tracking-[0.2em] opacity-75">
                          {session.seedSource.replace("_", " ")}
                        </p>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          </aside>

          <div className="flex min-w-0 flex-col gap-4 rounded-[28px] border border-black/10 bg-white/70 p-5 shadow-[var(--shadow)] backdrop-blur">
            <div className="rounded-2xl border border-black/10 bg-white px-4 py-4">
              <p className="text-xs uppercase tracking-[0.3em] text-[var(--muted)]">Session Overview</p>
              {selectedSession ? (
                <div className="mt-3 grid gap-3">
                  <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.2em]">
                    <span className="rounded-full border border-black/10 bg-[rgba(12,23,40,0.05)] px-2 py-1 text-[var(--muted)]">
                      {selectedSession.status}
                    </span>
                    <span className="rounded-full border border-black/10 bg-[rgba(12,23,40,0.05)] px-2 py-1 text-[var(--muted)]">
                      Seed {selectedSession.seedSource.replace("_", " ")}
                    </span>
                    {selectedSession.model && (
                      <span className="rounded-full border border-black/10 bg-[rgba(12,23,40,0.05)] px-2 py-1 text-[var(--muted)]">
                        {selectedSession.model}
                      </span>
                    )}
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">Initial thought</p>
                    <p className="mt-1 text-sm text-[var(--ink)]">{selectedSession.thoughtText}</p>
                  </div>
                  {normalizeText(selectedSession.finalThought) && (
                    <div>
                      <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">Final thought</p>
                      <p className="mt-1 text-sm text-[var(--ink)]">{selectedSession.finalThought}</p>
                    </div>
                  )}
                  {normalizeText(selectedSession.summary) && (
                    <div>
                      <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">Summary</p>
                      <p className="mt-1 text-sm text-[var(--ink)]">{selectedSession.summary}</p>
                    </div>
                  )}
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="rounded-xl border border-black/10 bg-[rgba(12,23,40,0.03)] px-3 py-2 text-xs text-[var(--muted)]">
                      Created: {formatDate(selectedSession.createdAt)}
                    </div>
                    <div className="rounded-xl border border-black/10 bg-[rgba(12,23,40,0.03)] px-3 py-2 text-xs text-[var(--muted)]">
                      Updated: {formatDate(selectedSession.updatedAt)}
                    </div>
                  </div>
                </div>
              ) : (
                <p className="mt-2 text-sm text-[var(--muted)]">
                  Select a session to inspect step-by-step details.
                </p>
              )}
            </div>

            <div>
              <div className="mb-3 flex items-center justify-between">
                <p className="text-xs uppercase tracking-[0.3em] text-[var(--muted)]">Step Timeline</p>
                <span className="text-xs text-[var(--muted)]">
                  {isLoading ? "Refreshing..." : `${orderedEvents.length} events`}
                </span>
              </div>

              {isLoading && orderedEvents.length === 0 && (
                <div className="rounded-2xl border border-black/10 bg-white px-4 py-3 text-sm text-[var(--muted)]">
                  Loading workspace activity...
                </div>
              )}

              {!isLoading && orderedEvents.length === 0 && (
                <div className="rounded-2xl border border-black/10 bg-white px-4 py-3 text-sm text-[var(--muted)]">
                  No workspace events yet.
                </div>
              )}

              {orderedEvents.length > 0 && (
                <div className="grid gap-3 xl:max-h-[74vh] xl:overflow-y-auto xl:pr-1">
                  {stepGroups.map((group, groupIndex) => {
                    const defaultOpen =
                      group.errors > 0 ||
                      groupIndex === stepGroups.length - 1 ||
                      group.step === null;
                    return (
                      <details
                        key={group.id}
                        className="group rounded-2xl border border-black/10 bg-white shadow-sm"
                        open={defaultOpen}
                      >
                        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3">
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-[var(--ink)]">{group.label}</p>
                            <p className="text-xs text-[var(--muted)]">
                              {formatDate(group.startedAt)}
                              {group.startedAt !== group.endedAt
                                ? ` - ${formatDate(group.endedAt)}`
                                : ""}
                            </p>
                          </div>
                          <div className="flex flex-wrap items-center justify-end gap-2 text-[10px] uppercase tracking-[0.2em]">
                            <span className="rounded-full border border-black/10 bg-[rgba(12,23,40,0.05)] px-2 py-1 text-[var(--muted)]">
                              {group.events.length} events
                            </span>
                            {group.toolCalls > 0 && (
                              <span className="rounded-full border border-sky-200 bg-sky-50 px-2 py-1 text-sky-700">
                                {group.toolCalls} tools
                              </span>
                            )}
                            {group.errors > 0 && (
                              <span className="rounded-full border border-red-200 bg-red-50 px-2 py-1 text-red-700">
                                {group.errors} errors
                              </span>
                            )}
                          </div>
                        </summary>

                        <div className="grid gap-3 px-3 pb-3 sm:px-4">
                          {group.events.map((event) => {
                            const sections = buildEventSections(event);
                            const pills = renderEventMetaPills(event);
                            return (
                              <details
                                key={event.id}
                                className="group/event rounded-2xl border border-black/10 bg-[rgba(12,23,40,0.03)]"
                                open={event.eventType === "error" || event.eventType === "tool_call"}
                              >
                                <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3 px-3 py-2">
                                  <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm font-medium text-[var(--ink)]">
                                      {buildEventHeadline(event)}
                                    </p>
                                    <p className="text-xs text-[var(--muted)]">{formatDate(event.createdAt)}</p>
                                  </div>
                                  <div className="flex flex-wrap items-center justify-end gap-2">
                                    <span
                                      className={`rounded-full border px-2 py-1 text-[10px] uppercase tracking-[0.2em] ${eventTone(
                                        event.eventType
                                      )}`}
                                    >
                                      {formatLabel(event.eventType)}
                                    </span>
                                    {pills.map((pill) => (
                                      <span
                                        key={`${event.id}-${pill}`}
                                        className="rounded-full border border-black/10 bg-white px-2 py-1 text-[10px] uppercase tracking-[0.2em] text-[var(--muted)]"
                                      >
                                        {pill}
                                      </span>
                                    ))}
                                  </div>
                                </summary>

                                <div className="grid gap-2 px-3 pb-3">
                                  {sections.length === 0 && (
                                    <p className="rounded-xl border border-black/10 bg-white px-3 py-2 text-xs text-[var(--muted)]">
                                      No payload for this event.
                                    </p>
                                  )}
                                  {sections.map((section) => (
                                    <EventSectionBlock
                                      key={`${event.id}-${section.id}`}
                                      section={section}
                                    />
                                  ))}
                                </div>
                              </details>
                            );
                          })}
                        </div>
                      </details>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
