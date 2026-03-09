"use client";

import { useEffect, useState } from "react";
import { withBasePath } from "@/lib/basePath";

type SidebarProps = {
  collapsed: boolean;
  onCollapseToggle: () => void;
  mobileOpen: boolean;
  onMobileClose: () => void;
  conversations: Array<{ id: string; title: string }>;
  activeConversationId: string | null;
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
  onDeleteConversation: (id: string) => void;
  disabled?: boolean;
};

export default function Sidebar({
  collapsed,
  onCollapseToggle,
  mobileOpen,
  onMobileClose,
  conversations,
  activeConversationId,
  onSelectConversation,
  onNewConversation,
  onDeleteConversation,
  disabled = false,
}: SidebarProps) {
  const [idleEnergy, setIdleEnergy] = useState<number | null>(null);
  const [cooldownRemainingMs, setCooldownRemainingMs] = useState<number | null>(null);
  const [idleStatus, setIdleStatus] = useState<
    "active" | "idle" | "disabled" | "unknown"
  >("unknown");
  const [isIdleThinking, setIsIdleThinking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let intervalId: number | null = null;
    const pollIntervalMs = 10000;

    const loadIdleState = async () => {
      try {
        const response = await fetch(withBasePath("/api/idle-state"));
        if (!response.ok) {
          return;
        }
        const data = (await response.json()) as {
          started?: boolean;
          inFlight?: boolean;
          currentEnergy?: number;
          cooldownRemainingMs?: number;
        };
        if (cancelled) {
          return;
        }
        setIdleEnergy(
          typeof data.currentEnergy === "number" ? data.currentEnergy : null
        );
        setCooldownRemainingMs(
          typeof data.cooldownRemainingMs === "number"
            ? data.cooldownRemainingMs
            : null
        );
        const started = data.started === true;
        const inFlight = data.inFlight === true;
        setIsIdleThinking(inFlight);
        if (!started) {
          setIdleStatus("disabled");
        } else if (
          typeof data.cooldownRemainingMs === "number" &&
          data.cooldownRemainingMs > 0
        ) {
          setIdleStatus("active");
        } else {
          setIdleStatus("idle");
        }
      } catch {
        if (!cancelled) {
          setCooldownRemainingMs((prev) => prev ?? null);
          setIdleStatus((prev) => prev ?? "unknown");
        }
      }
    };

    void loadIdleState();
    intervalId = window.setInterval(loadIdleState, pollIntervalMs);

    return () => {
      cancelled = true;
      if (intervalId) {
        window.clearInterval(intervalId);
      }
    };
  }, []);

  const energyLabel =
    typeof idleEnergy === "number" ? idleEnergy.toFixed(2) : "--";
  const energyBadgeClass =
    typeof idleEnergy === "number"
      ? "border-[var(--green-400)] text-[var(--green-600)]"
      : "border-black/10 text-[var(--muted)]";
  const energyText = collapsed ? "E" : energyLabel;
  const energyTitle = (() => {
    if (typeof idleEnergy !== "number") {
      return "Energy unavailable";
    }
    if (typeof cooldownRemainingMs === "number" && cooldownRemainingMs > 0) {
      const minutes = Math.ceil(cooldownRemainingMs / 60000);
      return `Energy ${energyLabel} (cooldown ${minutes}m)`;
    }
    return `Energy ${energyLabel}`;
  })();

  const statusLabel = (() => {
    if (idleStatus === "active") {
      return "Active";
    }
    if (idleStatus === "idle") {
      return isIdleThinking ? "Idle (thinking)" : "Idle";
    }
    if (idleStatus === "disabled") {
      return "Idle off";
    }
    return "Unknown";
  })();
  const statusBadgeClass = (() => {
    if (idleStatus === "active") {
      return "border-[var(--green-400)] text-[var(--green-600)]";
    }
    if (idleStatus === "idle") {
      return "border-sky-200 text-sky-600";
    }
    return "border-black/10 text-[var(--muted)]";
  })();
  const statusDotClass = (() => {
    if (idleStatus === "active") {
      return "bg-[var(--green-500)]";
    }
    if (idleStatus === "idle") {
      return "bg-sky-500";
    }
    return "bg-black/20";
  })();

  return (
    <>
      {mobileOpen && (
        <button
          type="button"
          className="fixed inset-0 z-30 bg-black/40 lg:hidden"
          aria-label="Close sidebar"
          onClick={onMobileClose}
        />
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex h-full w-72 flex-col gap-6 border-r border-white/60 bg-[linear-gradient(160deg,rgba(255,255,255,0.78),rgba(236,248,255,0.72))] px-5 py-6 shadow-[0_24px_56px_rgba(29,53,92,0.18)] backdrop-blur transition-transform duration-300 lg:static lg:translate-x-0 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        } ${collapsed ? "lg:w-20 lg:px-3" : "lg:w-72"}`}
      >
        <div className={`flex items-center ${collapsed ? "justify-center" : "justify-between"}`}>
          <div className={`flex items-center gap-3 ${collapsed ? "hidden" : ""}`}>
            <span className="h-3 w-3 rounded-full bg-[var(--green-500)] shadow-[0_0_12px_rgba(47,127,68,0.4)]" />
            <div>
              <p className="text-xs uppercase tracking-[0.3em] text-[var(--muted)]">
                Assistant
              </p>
              <p className="font-display text-lg text-[var(--ink)]">
                Memory Loop
              </p>
            </div>
          </div>
          <button
            type="button"
            className={`hidden rounded-full border border-black/10 text-[var(--muted)] hover:border-[var(--green-500)] hover:text-[var(--ink)] lg:inline-flex items-center justify-center ${collapsed ? "h-10 w-10 border-transparent hover:bg-white/70" : "px-3 py-1 text-[10px] uppercase tracking-[0.2em]"}`}
            onClick={onCollapseToggle}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m13 17 5-5-5-5" />
                <path d="m6 17 5-5-5-5" />
              </svg>
            ) : (
              "Collapse"
            )}
          </button>
        </div>

        <button
          type="button"
          className={`rounded-2xl border border-black/10 bg-[var(--green-500)] text-white shadow-[0_24px_56px_rgba(29,53,92,0.18)] hover:bg-[var(--green-600)] transition-all ${
            collapsed
              ? "flex h-12 w-12 items-center justify-center rounded-full p-0 mx-auto"
              : "px-4 py-3 text-left text-xs uppercase tracking-[0.2em]"
          }`}
          onClick={onNewConversation}
          disabled={disabled}
          title={collapsed ? "New chat" : undefined}
        >
          {collapsed ? (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M5 12h14" />
              <path d="M12 5v14" />
            </svg>
          ) : (
            "+ New chat"
          )}
        </button>

        <div className="flex-1 min-h-0 overflow-y-auto space-y-3">
          <p className={`text-xs uppercase tracking-[0.2em] text-[var(--muted)] ${collapsed ? "lg:hidden" : ""}`}>
            Conversations
          </p>
          {conversations.length === 0 ? (
            <p className={`text-sm text-[var(--muted)] ${collapsed ? "lg:hidden" : ""}`}>
              No conversations yet.
            </p>
          ) : (
            <ul className="space-y-2">
              {conversations.map((conversation) => (
                <li key={conversation.id}>
                  <div
                    className={`group flex w-full items-center gap-3 rounded-2xl border px-3 py-2 text-left text-sm transition ${
                      conversation.id === activeConversationId
                        ? "border-[var(--green-400)] bg-[rgba(20,159,147,0.12)] text-[var(--ink)]"
                        : "border-black/10 text-[var(--muted)] hover:border-[var(--green-400)]"
                    }`}
                  >
                    <button
                      type="button"
                      className="flex flex-1 items-center gap-3 truncate"
                      onClick={() => onSelectConversation(conversation.id)}
                      disabled={disabled}
                    >
                      <span className="h-2 w-2 flex-none rounded-full bg-[var(--green-500)]" />
                      <span className={`truncate ${collapsed ? "lg:hidden" : ""}`}>
                        {conversation.title}
                      </span>
                    </button>
                    {!collapsed && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteConversation(conversation.id);
                        }}
                        className="opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:text-red-500"
                        title="Delete conversation"
                        disabled={disabled}
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M18 6 6 18" />
                          <path d="m6 6 12 12" />
                        </svg>
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-auto space-y-2 text-xs text-[var(--muted)]">
          <div className="flex items-center justify-between">
            <span className={`${collapsed ? "lg:hidden" : ""}`}>Status</span>
            <span
              className={`inline-flex items-center gap-2 rounded-full border px-2 py-1 text-[10px] uppercase tracking-[0.2em] ${statusBadgeClass}`}
              title={statusLabel}
            >
              <span className={`h-2 w-2 rounded-full ${statusDotClass}`} />
              {!collapsed && <span>{statusLabel}</span>}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className={`${collapsed ? "lg:hidden" : ""}`}>Energy</span>
            <span
              className={`rounded-full border px-2 py-1 text-[10px] uppercase tracking-[0.2em] ${energyBadgeClass}`}
              title={energyTitle}
            >
              {energyText}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className={`${collapsed ? "lg:hidden" : ""}`}>Sync status</span>
            <span className="rounded-full border border-[var(--green-400)] px-2 py-1 text-[10px] uppercase tracking-[0.2em] text-[var(--green-600)]">
              Live
            </span>
          </div>
          <p className={`${collapsed ? "lg:hidden" : ""}`}>
            Memories saved locally in ChromaDB.
          </p>
        </div>
      </aside>
    </>
  );
}
