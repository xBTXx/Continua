export type ChatRole = "user" | "assistant" | "memory" | "system";

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ImageAttachment = {
  id: string;
  url: string;
  mimeType: string;
  name?: string;
  size?: number;
  expiresAt?: string;
};

export type ChatItem = {
  id: string;
  role: ChatRole;
  content: string;
  attachments?: ImageAttachment[];
  timestamp?: string;
  isStreaming?: boolean;
  injectionId?: string | null;
};

export type ConversationSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt?: string | null;
};

export type StoredMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments?: ImageAttachment[];
  createdAt: string;
  injectionId?: string | null;
};
