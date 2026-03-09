type Model = {
  id: string;
  name: string;
  capabilities?: string[];
};

type ModelSelectorProps = {
  models: Model[];
  value: string;
  onChange: (value: string) => void;
  reasoningEnabled: boolean;
  onReasoningChange: (value: boolean) => void;
  effort: string;
  onEffortChange: (value: string) => void;
};

const effortOptions = ["low", "medium", "high"];

export default function ModelSelector({
  models,
  value,
  onChange,
  reasoningEnabled,
  onReasoningChange,
  effort,
  onEffortChange,
}: ModelSelectorProps) {
  const selectedModel = models.find((model) => model.id === value);
  const supportsReasoning = selectedModel?.capabilities?.includes("reasoning");
  const supportsEffort = selectedModel?.capabilities?.includes("effort");
  const showReasoningOptions = supportsReasoning || supportsEffort;

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-black/10 bg-white/80 px-4 py-3 shadow-[var(--shadow)] backdrop-blur">
      <label className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
        Model
      </label>
      <select
        className="w-full rounded-xl border border-black/10 bg-white px-3 py-2 text-sm text-[var(--ink)] focus:border-[var(--green-500)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name}
          </option>
        ))}
      </select>

      {showReasoningOptions && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          {supportsReasoning && (
            <button
              type="button"
              className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs uppercase tracking-[0.16em] ${
                reasoningEnabled
                  ? "border-[var(--green-500)] bg-[var(--green-500)] text-white"
                  : "border-black/15 bg-white text-[var(--muted)]"
              }`}
              aria-pressed={reasoningEnabled}
              onClick={() => onReasoningChange(!reasoningEnabled)}
            >
              Reasoning
            </button>
          )}

          {supportsEffort && (
            <div className="flex items-center gap-2">
              <span className="text-xs uppercase tracking-[0.16em] text-[var(--muted)]">
                Effort
              </span>
              <select
                className="rounded-full border border-black/10 bg-white px-3 py-1.5 text-xs uppercase tracking-[0.16em] text-[var(--ink)] focus:border-[var(--green-500)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
                value={effort}
                onChange={(event) => onEffortChange(event.target.value)}
              >
                {effortOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
