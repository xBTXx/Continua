import { randomUUID } from "node:crypto";
import type { ImageAttachment } from "@/types/chat";
import { IMAGE_MIME_TYPES } from "./chatContent";

const RETENTION_DAYS = 30;

export function computeAttachmentExpiry(reference = new Date()) {
  const expiresAt = new Date(reference);
  expiresAt.setDate(expiresAt.getDate() + RETENTION_DAYS);
  return expiresAt;
}

export function normalizeAttachments(
  input: unknown,
  expiresAt: Date
): ImageAttachment[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const allowed = new Set<string>(IMAGE_MIME_TYPES);
  const safeExpiresAt = expiresAt.toISOString();
  const normalized: ImageAttachment[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Partial<ImageAttachment> & {
      url?: unknown;
      mimeType?: unknown;
      name?: unknown;
      size?: unknown;
      id?: unknown;
    };
    const url = typeof record.url === "string" ? record.url.trim() : "";
    const mimeType =
      typeof record.mimeType === "string" ? record.mimeType.trim() : "";
    if (!url || !mimeType || !allowed.has(mimeType)) {
      continue;
    }
    const name =
      typeof record.name === "string" && record.name.trim()
        ? record.name.trim()
        : undefined;
    const size =
      typeof record.size === "number" && Number.isFinite(record.size)
        ? record.size
        : undefined;
    const id =
      typeof record.id === "string" && record.id.trim()
        ? record.id.trim()
        : randomUUID();
    normalized.push({
      id,
      url,
      mimeType,
      name,
      size,
      expiresAt: safeExpiresAt,
    });
  }
  return normalized;
}

export function filterExpiredAttachments(
  attachments: ImageAttachment[] | null | undefined,
  expiresAt?: string | null
) {
  if (!attachments || attachments.length === 0) {
    return [];
  }
  const now = Date.now();
  const expiresMs =
    typeof expiresAt === "string" ? new Date(expiresAt).getTime() : NaN;
  if (Number.isFinite(expiresMs) && expiresMs <= now) {
    return [];
  }
  return attachments.filter((attachment) => {
    if (!attachment.expiresAt) {
      return true;
    }
    const attachmentMs = new Date(attachment.expiresAt).getTime();
    return Number.isNaN(attachmentMs) || attachmentMs > now;
  });
}
