"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { withBasePath } from "@/lib/basePath";

type IdleMetricItem = {
  id: string;
  seedsCount: number;
  thoughtsGenerated: number;
  storedCount: number;
  escalatedCount: number;
  deferredCount: number;
  actionsQueued: number;
  scratchpadNotes: number;
  personaKeywordHits?: number;
  personaSemanticHits?: number;
  energy?: number | null;
  modelLite?: string | null;
  modelSmart?: string | null;
  error?: string | null;
  createdAt: string;
};

type IdleMetricResponse = {
  total: number;
  items: IdleMetricItem[];
};

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

async function fetchIdleMetrics(
  limit: number,
  offset: number
): Promise<IdleMetricResponse> {
  const response = await fetch(
    withBasePath(`/api/idle-metrics?limit=${limit}&offset=${offset}`)
  );
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || "Unable to load idle metrics.");
  }
  return (await response.json()) as IdleMetricResponse;
}

export default function IdleMetricsPage() {
  const [items, setItems] = useState<IdleMetricItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(total / PAGE_SIZE)),
    [total]
  );

  const loadPage = async (pageNumber: number) => {
    setIsLoading(true);
    setError(null);
    try {
      const offset = (pageNumber - 1) * PAGE_SIZE;
      const data = await fetchIdleMetrics(PAGE_SIZE, offset);
      setItems(data.items);
      setTotal(data.total);

      const nextTotalPages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
      if (pageNumber > nextTotalPages) {
        setPage(nextTotalPages);
      }
    } catch (loadError) {
      const message =
        loadError instanceof Error ? loadError.message : "Unable to load idle metrics.";
      setError(message);
      setItems([]);
      setTotal(0);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadPage(page);
  }, [page]);

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
              Idle Metrics
            </h1>
            <p className="text-sm text-[var(--muted)]">
              {isLoading ? "Loading metrics..." : `${total} idle ticks logged`}
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
          {error && (
            <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}
          {!error && isLoading && (
            <div className="rounded-2xl border border-black/10 bg-white px-4 py-3 text-sm text-[var(--muted)]">
              Loading idle metrics...
            </div>
          )}
          {!error && !isLoading && items.length === 0 && (
            <div className="rounded-2xl border border-black/10 bg-white px-4 py-3 text-sm text-[var(--muted)]">
              No idle metrics logged yet.
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
                      <div className="grid gap-2">
                        <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
                          <span>Seeds {item.seedsCount}</span>
                          <span>Thoughts {item.thoughtsGenerated}</span>
                          <span>Stored {item.storedCount}</span>
                          <span>Escalated {item.escalatedCount}</span>
                          <span>Deferred {item.deferredCount}</span>
                          <span>Queued {item.actionsQueued}</span>
                          <span>Scratchpad {item.scratchpadNotes}</span>
                          <span>
                            Persona K {item.personaKeywordHits ?? 0}
                          </span>
                          <span>
                            Persona S {item.personaSemanticHits ?? 0}
                          </span>
                          <span>
                            Energy{" "}
                            {typeof item.energy === "number"
                              ? item.energy.toFixed(2)
                              : "--"}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
                          {item.modelLite && <span>Lite: {item.modelLite}</span>}
                          {item.modelSmart && <span>Smart: {item.modelSmart}</span>}
                        </div>
                        {item.error && (
                          <p className="text-xs text-red-600">Error: {item.error}</p>
                        )}
                      </div>
                      <span className="text-xs text-[var(--muted)]">
                        {formatDate(item.createdAt)}
                      </span>
                    </div>
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
