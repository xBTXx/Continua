"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { withBasePath } from "@/lib/basePath";

type MemoryItem = {
  id: string;
  content: string;
  createdAt?: string;
  sourceAt?: string;
  conversationId?: string;
  source?: string;
  model?: string;
  type?: string;
  category?: string;
  eventTime?: string;
  eventTimezone?: string;
  expiresAt?: string;
  tagsFlat?: string;
  resonanceTagsFlat?: string;
  resonancePrimary?: string;
  resonanceWeight?: string;
  resonanceIntensity?: number;
  resonanceState?: string;
};

type MemoryResponse = {
  total: number;
  items: MemoryItem[];
};

type MemoryFilter = "all" | "event" | "profile" | "fact" | "personal";

const PAGE_SIZE = 15;

function formatMemoryDate(raw?: string) {
  if (!raw) {
    return null;
  }
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

function formatEventDate(raw?: string) {
  if (!raw) {
    return null;
  }
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  if (match) {
    return `${match[1]} ${match[2]}`;
  }
  return raw;
}

function formatCategoryLabel(raw?: string) {
  if (!raw) {
    return null;
  }
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

async function fetchMemories(
  limit: number,
  offset: number,
  filter: MemoryFilter
): Promise<MemoryResponse> {
  const scopeParam = filter === "personal" ? "&scope=personal" : "";
  const typeParam =
    filter === "all" || filter === "personal" ? "" : `&type=${filter}`;
  const response = await fetch(
    withBasePath(`/api/memories?limit=${limit}&offset=${offset}${typeParam}${scopeParam}`)
  );
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || "Unable to load memories.");
  }
  return (await response.json()) as MemoryResponse;
}

export default function MemoriesPage() {
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<MemoryFilter>("all");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [showMetadata, setShowMetadata] = useState(false);

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(total / PAGE_SIZE)),
    [total]
  );

  const loadPage = useCallback(async (pageNumber: number, activeFilter = filter) => {
    setIsLoading(true);
    setError(null);
    try {
      const offset = (pageNumber - 1) * PAGE_SIZE;
      const data = await fetchMemories(PAGE_SIZE, offset, activeFilter);
      setMemories(data.items);
      setTotal(data.total);

      const nextTotalPages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
      if (pageNumber > nextTotalPages) {
        setPage(nextTotalPages);
      }
    } catch (loadError) {
      const message =
        loadError instanceof Error ? loadError.message : "Unable to load memories.";
      setError(message);
      setMemories([]);
      setTotal(0);
    } finally {
      setIsLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void loadPage(page);
  }, [loadPage, page]);

  const handleDelete = async (id: string) => {
    if (!window.confirm("Delete this memory?")) {
      return;
    }

    setDeletingId(id);
    setError(null);
    try {
      const scopeParam = filter === "personal" ? "?scope=personal" : "";
      const response = await fetch(
        withBasePath(`/api/memories/${encodeURIComponent(id)}${scopeParam}`),
        {
          method: "DELETE",
        }
      );
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || "Unable to delete memory.");
      }
      await loadPage(page);
    } catch (deleteError) {
      const message =
        deleteError instanceof Error ? deleteError.message : "Unable to delete memory.";
      setError(message);
    } finally {
      setDeletingId(null);
    }
  };

  const filterLabel = useMemo(() => {
    switch (filter) {
      case "event":
        return "event memories";
      case "profile":
        return "profile memories";
      case "fact":
        return "fact memories";
      case "personal":
        return "personal memories";
      default:
        return "saved memories";
    }
  }, [filter]);

  return (
    <div className="relative min-h-screen bg-[radial-gradient(circle_at_14%_18%,rgba(122,190,255,0.24),transparent_42%),radial-gradient(circle_at_85%_8%,rgba(96,229,210,0.24),transparent_38%),radial-gradient(circle_at_80%_90%,rgba(182,215,255,0.18),transparent_45%),linear-gradient(180deg,#edf3ff_0%,#eaf4ff_50%,#edf8ff_100%)] px-5 py-8 lg:px-10">
      <div className="pointer-events-none absolute -top-28 right-[-12%] h-[360px] w-[360px] rounded-full bg-[radial-gradient(circle,rgba(84,216,197,0.22),transparent_68%)] blur-2xl" />
      <div className="pointer-events-none absolute bottom-[-120px] left-[-140px] h-[320px] w-[320px] rounded-full bg-[radial-gradient(circle,rgba(108,168,255,0.28),transparent_70%)] blur-2xl" />

      <div className="relative mx-auto flex w-full max-w-5xl flex-col gap-6">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-[var(--muted)]">
              Assistant
            </p>
            <h1 className="font-display text-3xl text-[var(--ink)]">Memories</h1>
            <p className="text-sm text-[var(--muted)]">
              {isLoading ? "Loading memories..." : `${total} ${filterLabel}`}
            </p>
          </div>
          <Link
            href="/"
            className="rounded-full border border-black/10 bg-white/70 px-5 py-3 text-xs uppercase tracking-[0.2em] text-[var(--muted)] shadow-[var(--shadow)] backdrop-blur hover:border-[var(--green-400)] hover:text-[var(--ink)]"
          >
            Back to chat
          </Link>
        </header>

        <section className="rounded-[32px] border border-black/10 bg-white/70 p-6 shadow-[var(--shadow)] backdrop-blur">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-2">
              {([
                { id: "all", label: "All" },
                { id: "event", label: "Events" },
                { id: "profile", label: "Profile" },
                { id: "fact", label: "Facts" },
                { id: "personal", label: "Personal" },
              ] as Array<{ id: MemoryFilter; label: string }>).map((option) => {
                const active = filter === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    className={`rounded-full border px-3 py-1 text-xs uppercase tracking-[0.2em] shadow-sm ${
                      active
                        ? "border-transparent bg-[var(--green-500)] text-white"
                        : "border-black/10 text-[var(--muted)] hover:border-[var(--green-400)] hover:text-[var(--ink)]"
                    }`}
                    onClick={() => {
                      setPage(1);
                      setFilter(option.id);
                    }}
                    disabled={isLoading}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              className="rounded-full border border-black/10 px-3 py-1 text-xs uppercase tracking-[0.2em] text-[var(--muted)] hover:border-[var(--green-400)] hover:text-[var(--ink)]"
              onClick={() => setShowMetadata((prev) => !prev)}
            >
              {showMetadata ? "Hide metadata" : "Show metadata"}
            </button>
          </div>
          {error && (
            <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}
          {!error && isLoading && (
            <div className="rounded-2xl border border-black/10 bg-white px-4 py-3 text-sm text-[var(--muted)]">
              Loading memories...
            </div>
          )}
          {!error && !isLoading && memories.length === 0 && (
            <div className="rounded-2xl border border-black/10 bg-white px-4 py-3 text-sm text-[var(--muted)]">
              No memories stored yet.
            </div>
          )}
          {!error && !isLoading && memories.length > 0 && (
            <div className="grid gap-4">
              <ul className="grid gap-3">
                {memories.map((memory) => (
                  <li
                    key={memory.id}
                    className="rounded-2xl border border-black/10 bg-white px-4 py-4 text-sm text-[var(--ink)] shadow-sm"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="flex max-w-[720px] flex-wrap items-center gap-3">
                        {memory.type === "event" && (
                          <span className="rounded-full bg-[rgba(20,159,147,0.14)] px-2 py-1 text-[10px] uppercase tracking-[0.2em] text-[var(--green-600)]">
                            Event
                          </span>
                        )}
                        {memory.type === "profile" && (
                          <span className="rounded-full bg-[rgba(12,23,40,0.08)] px-2 py-1 text-[10px] uppercase tracking-[0.2em] text-[var(--ink)]">
                            Profile
                          </span>
                        )}
                        {memory.type === "personal" && (
                          <span className="rounded-full bg-[rgba(20,159,147,0.14)] px-2 py-1 text-[10px] uppercase tracking-[0.2em] text-[var(--green-600)]">
                            Personal
                          </span>
                        )}
                        {memory.category && (
                          <span className="rounded-full bg-[rgba(12,23,40,0.08)] px-2 py-1 text-[10px] uppercase tracking-[0.2em] text-[var(--ink)]">
                            {formatCategoryLabel(memory.category)}
                          </span>
                        )}
                        <p>{memory.content}</p>
                      </div>
                      <button
                        type="button"
                        className="rounded-full border border-black/10 px-3 py-1 text-xs uppercase tracking-[0.2em] text-[var(--muted)] hover:border-red-300 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-60"
                        onClick={() => handleDelete(memory.id)}
                        disabled={isLoading || deletingId === memory.id}
                      >
                        {deletingId === memory.id ? "Deleting..." : "Delete"}
                      </button>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-3 text-xs text-[var(--muted)]">
                      {memory.createdAt && (
                        <span>{formatMemoryDate(memory.createdAt)}</span>
                      )}
                      {memory.eventTime && (
                        <span>
                          Event time: {formatEventDate(memory.eventTime)}
                          {memory.eventTimezone ? ` ${memory.eventTimezone}` : ""}
                        </span>
                      )}
                      {memory.expiresAt && (
                        <span>Expires: {formatEventDate(memory.expiresAt)}</span>
                      )}
                      {memory.source && <span>Source: {memory.source}</span>}
                      {memory.model && <span>Model: {memory.model}</span>}
                    </div>
                    {showMetadata && (
                      <div className="mt-3 flex flex-wrap gap-3 text-xs text-[var(--muted)]">
                        {memory.sourceAt && memory.sourceAt !== memory.createdAt && (
                          <span>Source at: {formatMemoryDate(memory.sourceAt)}</span>
                        )}
                        {memory.resonancePrimary && (
                          <span>Resonance: {memory.resonancePrimary}</span>
                        )}
                        {memory.resonanceWeight && (
                          <span>Weight: {memory.resonanceWeight}</span>
                        )}
                        {typeof memory.resonanceIntensity === "number" && (
                          <span>Intensity: {memory.resonanceIntensity}</span>
                        )}
                        {memory.resonanceState && (
                          <span>State: {memory.resonanceState}</span>
                        )}
                        {memory.resonanceTagsFlat && (
                          <span>Resonance tags: {memory.resonanceTagsFlat}</span>
                        )}
                        {memory.tagsFlat && <span>Tags: {memory.tagsFlat}</span>}
                        {memory.conversationId && (
                          <span>Conversation: {memory.conversationId}</span>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
                  Page {page} of {totalPages}
                </p>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    className="rounded-full border border-black/10 px-4 py-2 text-xs uppercase tracking-[0.2em] text-[var(--muted)] hover:border-[var(--green-400)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={() => setPage((prev) => Math.max(1, prev - 1))}
                    disabled={page <= 1 || isLoading}
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    className="rounded-full border border-black/10 px-4 py-2 text-xs uppercase tracking-[0.2em] text-[var(--muted)] hover:border-[var(--green-400)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
                    disabled={page >= totalPages || isLoading}
                  >
                    Next
                  </button>
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
