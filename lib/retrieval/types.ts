export type MemorySnippet = {
  id?: string;
  content: string;
  createdAt?: string;
  sourceAt?: string;
  conversationId?: string;
  sourceMessageIds?: string[];
  sourceMessageStartId?: string;
  sourceMessageEndId?: string;
  sourceMessageCount?: number;
  resonancePrimary?: string;
  resonanceTagsFlat?: string;
  resonanceWeight?: string;
  resonanceIntensity?: number;
  resonanceState?: string;
};

export type ConversationExcerptMessage = {
  id: string;
  role: string;
  content: string;
  createdAt: string;
};

export type ConversationExcerpt = {
  conversationId: string;
  memoryContent: string;
  messages: ConversationExcerptMessage[];
};

export type MemoryFilters = {
  start?: string;
  end?: string;
  type?: string;
  category?: string;
  resonancePrimary?: string;
  resonanceWeight?: string;
};

export type MemoryRetrievalOptions = {
  filters?: MemoryFilters;
  topK?: number;
  collectionName?: string;
  negativeQueries?: string[];
};

export type PersonalMemoryRetrievalOptions = {
  topK?: number;
  category?: string;
  resonancePrimary?: string;
  resonanceWeight?: string;
};
