import type { ChatContentPart, ImageAttachment } from "@/types/chat";

export const IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export function isChatContentPart(value: unknown): value is ChatContentPart {
  if (!value || typeof value !== "object") {
    return false;
  }
  const part = value as ChatContentPart;
  if (part.type === "text") {
    return typeof part.text === "string";
  }
  if (part.type === "image_url") {
    return Boolean(part.image_url && typeof part.image_url.url === "string");
  }
  return false;
}

export function isChatContentArray(value: unknown): value is ChatContentPart[] {
  return Array.isArray(value) && value.every(isChatContentPart);
}

export function extractTextFromContent(
  content:
    | string
    | ChatContentPart[]
    | Record<string, unknown>
    | Array<Record<string, unknown>>
    | null
    | undefined
): string {
  if (!content) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  if (typeof content === "object" && !Array.isArray(content)) {
    if (typeof content.text === "string") {
      return content.text.trim();
    }
    if (typeof content.content === "string") {
      return content.content.trim();
    }
    if (Array.isArray(content.content)) {
      return extractTextFromContent(
        content.content as Array<Record<string, unknown>>
      );
    }
    return "";
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      if ("text" in part && typeof part.text === "string") {
        return part.text;
      }
      if ("content" in part && typeof part.content === "string") {
        return part.content;
      }
      if ("content" in part && Array.isArray(part.content)) {
        return extractTextFromContent(
          part.content as Array<Record<string, unknown>>
        );
      }
      return "";
    })
    .filter((text) => text && text.trim().length > 0)
    .join(" ")
    .trim();
}

export function buildChatContent(
  text: string,
  attachments: ImageAttachment[]
): string | ChatContentPart[] {
  if (!attachments || attachments.length === 0) {
    return text;
  }

  const parts: ChatContentPart[] = [];
  const trimmed = text.trim();
  if (trimmed) {
    parts.push({ type: "text", text: trimmed });
  }
  attachments.forEach((attachment) => {
    parts.push({
      type: "image_url",
      image_url: { url: attachment.url },
    });
  });
  return parts;
}
