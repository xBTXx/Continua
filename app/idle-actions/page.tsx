"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { withBasePath } from "@/lib/basePath";

type IdleActionItem = {
  id: string;
  thoughtText: string;
  seedId: string;
  seedSource: string;
  actions: Array<{
    type: string;
    rationale?: string;
    content?: string;
    safety_notes?: string;
    requires_user_confirmation?: boolean;
  }>;
  status: string;
  model?: string;
  createdAt: string;
};

type IdleActionResponse = {
  total: number;
  items: IdleActionItem[];
};

type StatusFilter = "all" | "pending" | "complete";

const PAGE_SIZE = 30;

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

async function fetchIdleActions(
  limit: number,
  offset: number,
  status: StatusFilter
): Promise<IdleActionResponse> {
  const statusParam = status === "all" ? "" : `&status=${status}`;
  const response = await fetch(
    withBasePath(`/api/idle-actions?limit=${limit}&offset=${offset}${statusParam}`)
  );
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || "Unable to load idle actions.");
  }
  return (await response.json()) as IdleActionResponse;
}

export default function IdleActionsPage() {
  const [items, setItems] = useState<IdleActionItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<StatusFilter>("pending");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actioningId, setActioningId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(total / PAGE_SIZE)),
    [total]
  );

  const loadPage = useCallback(async (pageNumber: number, activeFilter = filter) => {
    setIsLoading(true);
    setError(null);
    setNotice(null);
    try {
      const offset = (pageNumber - 1) * PAGE_SIZE;
      const data = await fetchIdleActions(PAGE_SIZE, offset, activeFilter);
      setItems(data.items);
      setTotal(data.total);

      const nextTotalPages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
      if (pageNumber > nextTotalPages) {
        setPage(nextTotalPages);
      }
    } catch (loadError) {
      const message =
        loadError instanceof Error ? loadError.message : "Unable to load idle actions.";
      setError(message);
      setItems([]);
      setTotal(0);
    } finally {
      setIsLoading(false);
    }
  }, [filter]);

  const handleStartConversation = async (id: string) => {
    setActioningId(id);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(withBasePath(`/api/idle-actions/${encodeURIComponent(id)}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start_conversation" }),
      });
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || "Unable to start conversation.");
      }
      setNotice(
        "Conversation created from idle action. Open chat to view it in the sidebar."
      );
      await loadPage(page, filter);
    } catch (applyError) {
      const message =
        applyError instanceof Error
          ? applyError.message
          : "Unable to start conversation.";
      setError(message);
    } finally {
      setActioningId(null);
    }
  };

  useEffect(() => {
    void loadPage(page);
  }, [loadPage, page]);

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
            <h1 className="font-display text-3xl text-[var(--ink)]">
              Idle Actions
            </h1>
            <p className="text-sm text-[var(--muted)]">
              {isLoading ? "Loading actions..." : `${total} queued actions`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href="/idle-metrics"
              className="rounded-full border border-black/10 bg-white/70 px-5 py-3 text-xs uppercase tracking-[0.2em] text-[var(--muted)] shadow-[var(--shadow)] backdrop-blur hover:border-[var(--green-400)] hover:text-[var(--ink)]"
            >
              Idle metrics
            </Link>
            <Link
              href="/idle-workspace"
              className="rounded-full border border-black/10 bg-white/70 px-5 py-3 text-xs uppercase tracking-[0.2em] text-[var(--muted)] shadow-[var(--shadow)] backdrop-blur hover:border-[var(--green-400)] hover:text-[var(--ink)]"
            >
              Workspace log
            </Link>
            <Link
              href="/"
              className="rounded-full border border-black/10 bg-white/70 px-5 py-3 text-xs uppercase tracking-[0.2em] text-[var(--muted)] shadow-[var(--shadow)] backdrop-blur hover:border-[var(--green-400)] hover:text-[var(--ink)]"
            >
              Back to chat
            </Link>
          </div>
        </header>

        <section className="rounded-[32px] border border-black/10 bg-white/70 p-6 shadow-[var(--shadow)] backdrop-blur">
          <div className="mb-5 flex flex-wrap gap-2">
            {([
              { id: "pending", label: "Pending" },
              { id: "complete", label: "Complete" },
              { id: "all", label: "All" },
            ] as Array<{ id: StatusFilter; label: string }>).map((option) => {
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

          {error && (
            <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}
          {notice && (
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
              {notice}
            </div>
          )}
          {!error && isLoading && (
            <div className="rounded-2xl border border-black/10 bg-white px-4 py-3 text-sm text-[var(--muted)]">
              Loading idle actions...
            </div>
          )}
          {!error && !isLoading && items.length === 0 && (
            <div className="rounded-2xl border border-black/10 bg-white px-4 py-3 text-sm text-[var(--muted)]">
              No idle action plans yet.
            </div>
          )}

          {!error && !isLoading && items.length > 0 && (
            <div className="grid gap-4">
              <ul className="grid gap-3">
                {items.map((item) => (
                  <li
                    key={item.id}
                    className="rounded-2xl border border-black/10 bg-white px-4 py-4 text-sm text-[var(--ink)] shadow-sm"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="flex max-w-[760px] flex-col gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded-full bg-[rgba(20,159,147,0.14)] px-2 py-1 text-[10px] uppercase tracking-[0.2em] text-[var(--green-600)]">
                            {item.status}
                          </span>
                          <span className="rounded-full bg-[rgba(12,23,40,0.08)] px-2 py-1 text-[10px] uppercase tracking-[0.2em] text-[var(--ink)]">
                            {item.seedSource.replace("_", " ")}
                          </span>
                          {item.model && (
                            <span className="rounded-full bg-[rgba(12,23,40,0.08)] px-2 py-1 text-[10px] uppercase tracking-[0.2em] text-[var(--ink)]">
                              {item.model}
                            </span>
                          )}
                        </div>
                        <p className="text-[15px] font-medium">{item.thoughtText}</p>
                        <p className="text-xs text-[var(--muted)]">
                          Seed: {item.seedId}
                        </p>
                        {item.status === "pending" &&
                          item.actions.some((action) => action.type === "start_conversation") && (
                            <button
                              type="button"
                              className="mt-2 w-fit rounded-full border border-black/10 px-4 py-2 text-xs uppercase tracking-[0.2em] text-[var(--muted)] hover:border-[var(--green-400)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-60"
                              onClick={() => handleStartConversation(item.id)}
                              disabled={isLoading || actioningId === item.id}
                            >
                              {actioningId === item.id
                                ? "Starting..."
                                : "Start conversation"}
                            </button>
                          )}
                      </div>
                      <span className="text-xs text-[var(--muted)]">
                        {formatDate(item.createdAt)}
                      </span>
                    </div>

                    {item.actions.length > 0 && (
                      <div className="mt-4 grid gap-3">
                        {item.actions.map((action, index) => (
                          <div
                            key={`${item.id}-${action.type}-${index}`}
                            className="rounded-2xl border border-black/10 bg-[rgba(12,23,40,0.04)] px-4 py-3"
                          >
                            <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
                              <span>{action.type.replace("_", " ")}</span>
                              {action.requires_user_confirmation !== false && (
                                <span className="rounded-full bg-[rgba(20,159,147,0.2)] px-2 py-1 text-[10px] uppercase tracking-[0.2em] text-[var(--green-600)]">
                                  Needs approval
                                </span>
                              )}
                            </div>
                            {action.rationale && (
                              <p className="mt-2 text-sm text-[var(--ink)]">
                                {action.rationale}
                              </p>
                            )}
                            {action.content && (
                              <pre className="mt-2 whitespace-pre-wrap break-words overflow-x-auto rounded-xl border border-black/10 bg-white px-3 py-2 text-xs text-[var(--ink)]">
                                {action.content}
                              </pre>
                            )}
                            {action.safety_notes && (
                              <p className="mt-2 text-xs text-[var(--muted)]">
                                Safety: {action.safety_notes}
                              </p>
                            )}
                          </div>
                        ))}
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
