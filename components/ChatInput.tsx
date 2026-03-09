import { useRef } from "react";
import type { ImageAttachment } from "@/types/chat";

type ChatInputProps = {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  disabled?: boolean;
  attachments?: ImageAttachment[];
  onAddAttachments?: (files: FileList) => void;
  onRemoveAttachment?: (id: string) => void;
  supportsVision?: boolean;
};

export default function ChatInput({
  value,
  onChange,
  onSend,
  disabled = false,
  attachments = [],
  onAddAttachments,
  onRemoveAttachment,
  supportsVision = false,
}: ChatInputProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const canAttach = supportsVision && onAddAttachments;

  return (
    <div className="rounded-3xl border border-black/10 bg-white/90 p-4 shadow-[var(--shadow)] backdrop-blur">
      <div className="flex flex-col gap-3">
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {attachments.map((attachment) => (
              <div
                key={attachment.id}
                className="group relative overflow-hidden rounded-2xl border border-black/10 bg-white/80"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- user-selected previews rely on data URLs. */}
                <img
                  src={attachment.url}
                  alt={attachment.name ?? "Image attachment"}
                  className="h-20 w-24 object-cover"
                />
                {onRemoveAttachment && (
                  <button
                    type="button"
                    className="absolute right-2 top-2 rounded-full bg-black/70 px-2 py-1 text-[10px] uppercase tracking-[0.2em] text-white opacity-0 transition group-hover:opacity-100"
                    onClick={() => onRemoveAttachment(attachment.id)}
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onPaste={(event) => {
            if (!onAddAttachments) {
              return;
            }
            const files = event.clipboardData?.files;
            if (files && files.length > 0) {
              const text = event.clipboardData?.getData("text/plain") ?? "";
              if (!text.trim()) {
                event.preventDefault();
              }
              onAddAttachments(files);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSend();
            }
          }}
          rows={3}
          placeholder="Ask the assistant to remember, plan, or summarize..."
          className="w-full resize-none rounded-2xl border border-black/10 bg-white px-4 py-3 text-sm text-[var(--ink)] focus:border-[var(--green-500)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
          disabled={disabled}
        />
        <div className="flex items-center justify-between">
          <div className="flex flex-wrap items-center gap-3">
            {canAttach && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  multiple
                  className="hidden"
                  onChange={(event) => {
                    const files = event.target.files;
                    if (files && onAddAttachments) {
                      onAddAttachments(files);
                    }
                    event.target.value = "";
                  }}
                  disabled={disabled}
                />
                <button
                  type="button"
                  className={`rounded-full border px-4 py-2 text-[10px] uppercase tracking-[0.2em] ${
                    disabled
                      ? "cursor-not-allowed border-black/10 bg-black/5 text-[var(--muted)]"
                      : "border-[var(--green-500)] text-[var(--green-600)] hover:bg-[rgba(59,155,90,0.08)]"
                  }`}
                  onClick={() => fileInputRef.current?.click()}
                  disabled={disabled}
                >
                  Add image
                </button>
              </>
            )}
            <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
              Shift + Enter for a new line
            </p>
          </div>
          <button
            type="button"
            className={`rounded-full px-5 py-2 text-xs uppercase tracking-[0.2em] shadow-[var(--shadow)] ${
              disabled || (!value.trim() && attachments.length === 0)
                ? "cursor-not-allowed bg-black/10 text-[var(--muted)]"
                : "bg-[var(--green-500)] text-white hover:bg-[var(--green-600)]"
            }`}
            onClick={onSend}
            disabled={disabled || (!value.trim() && attachments.length === 0)}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
