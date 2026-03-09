type TokenCounterProps = {
  used: number;
  limit: number;
};

export default function TokenCounter({ used, limit }: TokenCounterProps) {
  const clamped = Math.min(used, limit);
  const percent = Math.min(100, Math.round((clamped / limit) * 100));

  return (
    <div className="flex min-w-[200px] flex-col gap-2 rounded-2xl border border-black/10 bg-white/70 px-4 py-3 shadow-[var(--shadow)] backdrop-blur">
      <div className="flex items-center justify-between text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
        <span>Context</span>
        <span className="text-[var(--ink)]">{percent}%</span>
      </div>
      <div className="h-2 w-full rounded-full bg-black/10">
        <div
          className="h-2 rounded-full bg-gradient-to-r from-[var(--green-400)] via-[var(--green-500)] to-[var(--green-600)]"
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="text-xs text-[var(--muted)]">
        {clamped.toLocaleString("en-US")} / {limit.toLocaleString("en-US")}
      </div>
    </div>
  );
}
