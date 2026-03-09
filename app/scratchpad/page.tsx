"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { withBasePath } from "@/lib/basePath";

type ScratchpadNote = {
  id: string;
  content: string;
  createdAt: string;
  assignedConversationId?: string | null;
  assignedAt?: string | null;
  consumedAt?: string | null;
};

type ScratchpadResponse = {
  total: number;
  items: ScratchpadNote[];
};

type StatusFilter = "active" | "consumed" | "all";

const PAGE_SIZE = 30;

function formatDate(raw?: string | null) {
  if (!raw) {
    return "—";
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

async function fetchScratchpad(
  limit: number,
  offset: number,
  status: StatusFilter
): Promise<ScratchpadResponse> {
  const statusParam = status === "active" ? "" : `&status=${status}`;
  const response = await fetch(
    withBasePath(`/api/scratchpad?limit=${limit}&offset=${offset}${statusParam}`)
  );
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || "Unable to load scratchpad notes.");
  }
  return (await response.json()) as ScratchpadResponse;
}

export default function ScratchpadPage() {
  const [items, setItems] = useState<ScratchpadNote[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<StatusFilter>("active");
  const [isLoading, setIsLoading] = useState(false);
  const [deleting, setDeleting] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(total / PAGE_SIZE)),
    [total]
  );

  const loadPage = useCallback(async (pageNumber: number, activeFilter = filter) => {
    setIsLoading(true);
    setError(null);
    try {
      const offset = (pageNumber - 1) * PAGE_SIZE;
      const data = await fetchScratchpad(PAGE_SIZE, offset, activeFilter);
      setItems(data.items);
      setTotal(data.total);

      const nextTotalPages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
      if (pageNumber > nextTotalPages) {
        setPage(nextTotalPages);
      }
    } catch (loadError) {
      const message =
        loadError instanceof Error
          ? loadError.message
          : "Unable to load scratchpad notes.";
      setError(message);
      setItems([]);
      setTotal(0);
    } finally {
      setIsLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void loadPage(page);
  }, [loadPage, page]);

  const handleDelete = async (noteId: string) => {
    if (!noteId) {
      return;
    }
    setDeleting((prev) => ({ ...prev, [noteId]: true }));
    setError(null);
    try {
      const response = await fetch(
        withBasePath(`/api/scratchpad?id=${encodeURIComponent(noteId)}`),
        {
        method: "DELETE",
        }
      );
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || "Unable to delete scratchpad note.");
      }
      setItems((prev) => prev.filter((note) => note.id !== noteId));
      setTotal((prev) => Math.max(0, prev - 1));
    } catch (deleteError) {
      const message =
        deleteError instanceof Error
          ? deleteError.message
          : "Unable to delete scratchpad note.";
      setError(message);
    } finally {
      setDeleting((prev) => {
        const next = { ...prev };
        delete next[noteId];
        return next;
      });
    }
  };

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
              Scratchpad
            </h1>
            <p className="text-sm text-[var(--muted)]">
              {isLoading ? "Loading notes..." : `${total} notes`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
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
              { id: "active", label: "Active" },
              { id: "consumed", label: "Consumed" },
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
            <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {isLoading && (
            <div className="rounded-2xl border border-dashed border-black/10 bg-white/60 px-6 py-12 text-center text-sm text-[var(--muted)]">
              Loading scratchpad notes...
            </div>
          )}

          {!isLoading && !error && items.length === 0 && (
            <div className="rounded-2xl border border-dashed border-black/10 bg-white/60 px-6 py-12 text-center text-sm text-[var(--muted)]">
              No scratchpad notes yet.
            </div>
          )}

          {!isLoading && items.length > 0 && (
            <div className="grid gap-4">
              {items.map((note) => (
                <div
                  key={note.id}
                  className="rounded-3xl border border-black/10 bg-white p-5 shadow-[var(--shadow)]"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="text-sm text-[var(--ink)]">{note.content}</div>
                    <div className="flex items-center gap-2">
                      <span
                        className={`rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.2em] ${
                          note.consumedAt
                            ? "bg-black/5 text-[var(--muted)]"
                            : "bg-[rgba(20,159,147,0.14)] text-[var(--green-600)]"
                        }`}
                      >
                        {note.consumedAt ? "Consumed" : "Active"}
                      </span>
                      <button
                        type="button"
                        aria-label="Delete scratchpad note"
                        className="rounded-full border border-black/10 px-2 py-1 text-[10px] uppercase tracking-[0.2em] text-[var(--muted)] hover:border-red-300 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-60"
                        onClick={() => handleDelete(note.id)}
                        disabled={isLoading || Boolean(deleting[note.id])}
                      >
                        X
                      </button>
                    </div>
                  </div>
                  <div className="mt-3 grid gap-1 text-xs text-[var(--muted)]">
                    <div>Created: {formatDate(note.createdAt)}</div>
                    <div>Assigned: {formatDate(note.assignedAt)}</div>
                    <div>Consumed: {formatDate(note.consumedAt)}</div>
                    {note.assignedConversationId && (
                      <div className="truncate">
                        Conversation: {note.assignedConversationId}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {totalPages > 1 && (
            <div className="mt-6 flex flex-wrap items-center justify-between gap-3 text-xs text-[var(--muted)]">
              <span>
                Page {page} of {totalPages}
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="rounded-full border border-black/10 px-3 py-1 uppercase tracking-[0.2em] hover:border-[var(--green-400)] hover:text-[var(--ink)] disabled:opacity-40"
                  onClick={() => setPage((prev) => Math.max(1, prev - 1))}
                  disabled={page <= 1 || isLoading}
                >
                  Prev
                </button>
                <button
                  type="button"
                  className="rounded-full border border-black/10 px-3 py-1 uppercase tracking-[0.2em] hover:border-[var(--green-400)] hover:text-[var(--ink)] disabled:opacity-40"
                  onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
                  disabled={page >= totalPages || isLoading}
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
