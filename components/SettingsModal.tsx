"use client";

import { useState } from "react";
import { withBasePath } from "@/lib/basePath";

type SettingsModalProps = {
  isOpen: boolean;
  onClose: () => void;
  systemPrompt: string;
  onSystemPromptChange: (value: string) => void;
  personaProfile: string;
  onPersonaProfileChange: (value: string) => void;
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  webSearchEnabled: boolean;
  onWebSearchEnabledChange: (value: boolean) => void;
  idleThinkingEnabled: boolean;
  onIdleThinkingEnabledChange: (value: boolean) => void;
  imapHost: string;
  onImapHostChange: (value: string) => void;
  imapPort: string;
  onImapPortChange: (value: string) => void;
  smtpHost: string;
  onSmtpHostChange: (value: string) => void;
  smtpPort: string;
  onSmtpPortChange: (value: string) => void;
};

export default function SettingsModal({
  isOpen,
  onClose,
  systemPrompt,
  onSystemPromptChange,
  personaProfile,
  onPersonaProfileChange,
  apiKey,
  onApiKeyChange,
  webSearchEnabled,
  onWebSearchEnabledChange,
  idleThinkingEnabled,
  onIdleThinkingEnabledChange,
  imapHost,
  onImapHostChange,
  imapPort,
  onImapPortChange,
  smtpHost,
  onSmtpHostChange,
  smtpPort,
  onSmtpPortChange,
}: SettingsModalProps) {
  const [refineLoading, setRefineLoading] = useState(false);
  const [refineError, setRefineError] = useState<string | null>(null);
  const [refinedPersona, setRefinedPersona] = useState<string | null>(null);
  const [refinedSourceCount, setRefinedSourceCount] = useState<number | null>(null);
  const [refinedFallback, setRefinedFallback] = useState(false);

  if (!isOpen) {
    return null;
  }

  const handleRefinePersona = async () => {
    setRefineLoading(true);
    setRefineError(null);
    try {
      const response = await fetch(withBasePath("/api/persona"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: apiKey.trim() || undefined,
          appUrl: window.location.origin,
        }),
      });
      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || "Persona refinement failed.");
      }
      const data = (await response.json()) as {
        persona?: string;
        sourceCount?: number;
        usedFallback?: boolean;
      };
      const persona =
        typeof data.persona === "string" && data.persona.trim().length > 0
          ? data.persona
          : "";
      setRefinedPersona(persona || null);
      setRefinedSourceCount(
        typeof data.sourceCount === "number" ? data.sourceCount : null
      );
      setRefinedFallback(Boolean(data.usedFallback));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Persona refinement failed.";
      setRefineError(message);
    } finally {
      setRefineLoading(false);
    }
  };

  const handleApplyRefinedPersona = () => {
    if (refinedPersona && refinedPersona.trim().length > 0) {
      onPersonaProfileChange(refinedPersona);
    }
    setRefinedPersona(null);
    setRefinedSourceCount(null);
    setRefinedFallback(false);
  };

  const handleDiscardRefinedPersona = () => {
    setRefinedPersona(null);
    setRefinedSourceCount(null);
    setRefinedFallback(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4 py-10">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="relative z-10 flex max-h-full w-full max-w-2xl flex-col rounded-3xl border border-black/10 bg-white p-6 shadow-[var(--shadow)]"
      >
        <div className="flex shrink-0 items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-[var(--muted)]">
              Settings
            </p>
            <h2 id="settings-title" className="font-display text-2xl text-[var(--ink)]">
              Configure Assistant
            </h2>
          </div>
          <button
            type="button"
            className="rounded-full border border-black/10 px-3 py-1 text-xs uppercase tracking-[0.2em] text-[var(--muted)] hover:border-[var(--green-500)] hover:text-[var(--ink)]"
            onClick={onClose}
          >
            Close
          </button>
        </div>

        <div className="mt-6 flex-1 overflow-y-auto pr-2">
          <div className="grid gap-5">
            <label className="grid gap-2 text-sm text-[var(--muted)]">
              System prompt
              <textarea
                value={systemPrompt}
                onChange={(event) => onSystemPromptChange(event.target.value)}
                rows={4}
                className="w-full rounded-2xl border border-black/10 bg-white px-4 py-3 text-sm text-[var(--ink)] focus:border-[var(--green-500)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
              />
            </label>

            <div className="grid gap-3 rounded-2xl border border-black/10 bg-white px-4 py-4 text-sm text-[var(--muted)]">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <span className="block text-[var(--ink)]">Dynamic persona</span>
                  <span className="mt-1 block text-xs text-[var(--muted)]">
                    Generated from the assistant&apos;s personal memories. Use the
                    refine button to draft an update.
                  </span>
                </div>
                <button
                  type="button"
                  className="rounded-full border border-black/10 px-3 py-2 text-[0.65rem] uppercase tracking-[0.2em] text-[var(--ink)] hover:border-[var(--green-500)] hover:text-[var(--green-600)] disabled:cursor-not-allowed disabled:opacity-60"
                  onClick={handleRefinePersona}
                  disabled={refineLoading}
                >
                  {refineLoading ? "Refining..." : "Refine persona"}
                </button>
              </div>
              <textarea
                value={personaProfile}
                onChange={(event) => onPersonaProfileChange(event.target.value)}
                rows={4}
                className="w-full rounded-2xl border border-black/10 bg-white px-4 py-3 text-sm text-[var(--ink)] focus:border-[var(--green-500)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
              />
              {refineError && (
                <p className="text-xs text-red-600">{refineError}</p>
              )}
              {refinedPersona && (
                <div className="grid gap-3 rounded-2xl border border-dashed border-black/15 bg-[var(--surface)] px-4 py-4 text-xs text-[var(--muted)]">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[var(--ink)]">Generated draft</span>
                    {typeof refinedSourceCount === "number" && (
                      <span>
                        {refinedFallback
                          ? "Fallback used"
                          : `Sources: ${refinedSourceCount}`}
                      </span>
                    )}
                  </div>
                  <textarea
                    value={refinedPersona}
                    onChange={(event) => setRefinedPersona(event.target.value)}
                    rows={5}
                    className="w-full rounded-2xl border border-black/10 bg-white px-4 py-3 text-sm text-[var(--ink)] focus:border-[var(--green-500)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
                  />
                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      className="rounded-full bg-[var(--green-500)] px-4 py-2 text-[0.65rem] uppercase tracking-[0.2em] text-white shadow-[var(--shadow)] hover:bg-[var(--green-600)]"
                      onClick={handleApplyRefinedPersona}
                    >
                      Use draft
                    </button>
                    <button
                      type="button"
                      className="rounded-full border border-black/10 px-4 py-2 text-[0.65rem] uppercase tracking-[0.2em] text-[var(--muted)] hover:border-[var(--green-500)] hover:text-[var(--ink)]"
                      onClick={handleDiscardRefinedPersona}
                    >
                      Discard
                    </button>
                  </div>
                </div>
              )}
            </div>

            <label className="grid gap-2 text-sm text-[var(--muted)]">
              OpenRouter API key
              <input
                type="password"
                value={apiKey}
                onChange={(event) => onApiKeyChange(event.target.value)}
                placeholder="sk-or-..."
                className="w-full rounded-2xl border border-black/10 bg-white px-4 py-3 text-sm text-[var(--ink)] focus:border-[var(--green-500)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
              />
            </label>

            <label className="flex items-center justify-between gap-4 rounded-2xl border border-black/10 bg-white px-4 py-3 text-sm text-[var(--muted)]">
              <span>
                <span className="block text-[var(--ink)]">Web search</span>
                <span className="mt-1 block text-xs text-[var(--muted)]">
                  Ground responses with the OpenRouter web plugin (adds cost).
                </span>
              </span>
              <input
                type="checkbox"
                checked={webSearchEnabled}
                onChange={(event) => onWebSearchEnabledChange(event.target.checked)}
                className="h-5 w-5 accent-[var(--green-500)]"
              />
            </label>

            <label className="flex items-center justify-between gap-4 rounded-2xl border border-black/10 bg-white px-4 py-3 text-sm text-[var(--muted)]">
              <span>
                <span className="block text-[var(--ink)]">IDLE thinking</span>
                <span className="mt-1 block text-xs text-[var(--muted)]">
                  Run the assistant&apos;s background idle thoughts and actions.
                </span>
              </span>
              <input
                type="checkbox"
                checked={idleThinkingEnabled}
                onChange={(event) => onIdleThinkingEnabledChange(event.target.checked)}
                className="h-5 w-5 accent-[var(--green-500)]"
              />
            </label>

            <div className="grid gap-3 rounded-2xl border border-dashed border-black/10 p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
                Email
              </p>
              <div className="grid gap-3 md:grid-cols-2">
                <label className="grid gap-2 text-sm text-[var(--muted)]">
                  IMAP host
                  <input
                    value={imapHost}
                    onChange={(event) => onImapHostChange(event.target.value)}
                    placeholder="imap.example.com"
                    className="w-full rounded-xl border border-black/10 bg-white px-3 py-2 text-sm text-[var(--ink)] focus:border-[var(--green-500)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
                  />
                </label>
                <label className="grid gap-2 text-sm text-[var(--muted)]">
                  IMAP port
                  <input
                    value={imapPort}
                    onChange={(event) => onImapPortChange(event.target.value)}
                    placeholder="993"
                    className="w-full rounded-xl border border-black/10 bg-white px-3 py-2 text-sm text-[var(--ink)] focus:border-[var(--green-500)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
                  />
                </label>
                <label className="grid gap-2 text-sm text-[var(--muted)]">
                  SMTP host
                  <input
                    value={smtpHost}
                    onChange={(event) => onSmtpHostChange(event.target.value)}
                    placeholder="smtp.example.com"
                    className="w-full rounded-xl border border-black/10 bg-white px-3 py-2 text-sm text-[var(--ink)] focus:border-[var(--green-500)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
                  />
                </label>
                <label className="grid gap-2 text-sm text-[var(--muted)]">
                  SMTP port
                  <input
                    value={smtpPort}
                    onChange={(event) => onSmtpPortChange(event.target.value)}
                    placeholder="587"
                    className="w-full rounded-xl border border-black/10 bg-white px-3 py-2 text-sm text-[var(--ink)] focus:border-[var(--green-500)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
                  />
                </label>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-black/5 bg-[var(--surface)] px-3 py-3 text-xs text-[var(--muted)]">
                <span>Outlook OAuth connection (read/send/draft via Graph).</span>
                <a
                  href={withBasePath("/api/oauth/outlook/start?account_id=owner")}
                  className="rounded-full border border-black/10 px-3 py-2 text-[0.65rem] uppercase tracking-[0.2em] text-[var(--ink)] hover:border-[var(--green-500)] hover:text-[var(--green-600)]"
                >
                  Connect Outlook
                </a>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-6 flex shrink-0 items-center justify-between text-xs text-[var(--muted)]">
          <span>
            System prompt, persona profile, and IDLE thinking sync to the server.
            Other settings stay local.
          </span>
          <button
            type="button"
            className="rounded-full bg-[var(--green-500)] px-4 py-2 text-xs uppercase tracking-[0.2em] text-white shadow-[var(--shadow)] hover:bg-[var(--green-600)]"
            onClick={onClose}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
