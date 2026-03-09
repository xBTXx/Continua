type ToolDebugPanelProps = {
  enabled: boolean;
  data: unknown;
  loading: boolean;
  error?: string | null;
  onToggle: (enabled: boolean) => void;
  onRefresh: () => void;
};

export default function ToolDebugPanel({
  enabled,
  data,
  loading,
  error,
  onToggle,
  onRefresh,
}: ToolDebugPanelProps) {
  return (
    <div className="rounded-2xl border border-black/10 bg-white/80 p-4 shadow-[var(--shadow)] backdrop-blur">
      <div className="flex items-center justify-between">
        <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
          Tool Debug
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onToggle(!enabled)}
            className={`rounded-full border px-3 py-1 text-[0.6rem] uppercase tracking-[0.2em] ${
              enabled
                ? "border-[var(--green-500)] text-[var(--green-600)]"
                : "border-black/10 text-[var(--muted)]"
            }`}
          >
            {enabled ? "On" : "Off"}
          </button>
          <button
            type="button"
            onClick={onRefresh}
            className="rounded-full border border-black/10 px-3 py-1 text-[0.6rem] uppercase tracking-[0.2em] text-[var(--muted)] hover:border-[var(--green-400)] hover:text-[var(--ink)]"
          >
            Refresh
          </button>
        </div>
      </div>

      {!enabled && (
        <div className="mt-3 rounded-xl border border-dashed border-black/10 px-3 py-2 text-xs text-[var(--muted)]">
          Enable to capture raw tool outputs for the next request.
        </div>
      )}

      {enabled && loading && (
        <div className="mt-3 rounded-xl border border-dashed border-black/10 px-3 py-2 text-xs text-[var(--muted)]">
          Capturing tool outputs...
        </div>
      )}

      {enabled && error && (
        <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}

      {enabled && !loading && !error && Boolean(data) && (
        <pre className="mt-3 max-h-72 overflow-auto rounded-xl border border-black/10 bg-black/90 p-3 text-[0.7rem] text-green-100">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}

      {enabled && !loading && !error && !data && (
        <div className="mt-3 rounded-xl border border-dashed border-black/10 px-3 py-2 text-xs text-[var(--muted)]">
          No tool output captured yet.
        </div>
      )}
    </div>
  );
}
