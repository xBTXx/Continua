import { useMemo, useState } from "react";

type ToolStatus = {
  id: string;
  label: string;
  status: "ok" | "error";
  details: string[];
};

type ToolboxStatusProps = {
  tools: ToolStatus[];
  loading: boolean;
  error?: string | null;
  onRefresh: () => void;
};

export default function ToolboxStatus({
  tools,
  loading,
  error,
  onRefresh,
}: ToolboxStatusProps) {
  const [expanded, setExpanded] = useState(false);
  const healthyCount = useMemo(
    () => tools.filter((tool) => tool.status === "ok").length,
    [tools]
  );

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-white/65 bg-[linear-gradient(165deg,rgba(255,255,255,0.84),rgba(236,248,255,0.76))] p-4 shadow-[var(--shadow)] backdrop-blur-xl">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="inline-flex min-w-0 flex-1 items-center gap-2 rounded-full border border-white/80 bg-white/70 px-3 py-1.5 text-left text-xs uppercase tracking-[0.2em] text-[var(--muted)] hover:border-[var(--green-400)] hover:text-[var(--ink)]"
        >
          <span className="truncate">Toolbox</span>
          <span className="rounded-full border border-black/10 px-2 py-0.5 text-[0.55rem] text-[var(--ink)]">
            {healthyCount}/{tools.length}
          </span>
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
            className={`ml-auto transition-transform ${expanded ? "rotate-180" : ""}`}
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        <button
          type="button"
          onClick={onRefresh}
          className="rounded-full border border-white/80 bg-white/70 px-3 py-1.5 text-[0.62rem] uppercase tracking-[0.2em] text-[var(--muted)] hover:border-[var(--green-400)] hover:text-[var(--ink)]"
        >
          Refresh
        </button>
      </div>

      {expanded && loading && (
        <div className="rounded-xl border border-dashed border-black/10 bg-white/70 px-3 py-2 text-xs text-[var(--muted)]">
          Checking tool status...
        </div>
      )}

      {expanded && !loading && error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}

      {expanded && !loading && !error && tools.length === 0 && (
        <div className="rounded-xl border border-dashed border-black/10 bg-white/70 px-3 py-2 text-xs text-[var(--muted)]">
          No tools configured yet.
        </div>
      )}

      {expanded && !loading && !error && tools.length > 0 && (
        <ul className="flex flex-col gap-2">
          {tools.map((tool) => (
            <li
              key={tool.id}
              className="flex items-center justify-between rounded-xl border border-black/10 bg-white/75 px-3 py-2"
            >
              <span className="truncate text-sm text-[var(--ink)]">{tool.label}</span>
              <span
                className={`ml-3 h-2.5 w-2.5 flex-none rounded-full ${
                  tool.status === "ok"
                    ? "bg-[var(--green-500)] shadow-[0_0_10px_rgba(20,159,147,0.55)]"
                    : "bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.45)]"
                }`}
                aria-label={tool.status === "ok" ? "healthy" : "error"}
                title={tool.status === "ok" ? "Healthy" : "Error"}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
