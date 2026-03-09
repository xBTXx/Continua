import { createEmbeddingRequest } from "./openrouter";

type EmbeddingResponse = {
  data?: Array<{ embedding?: number[] }>;
};

export async function generateEmbedding(
  text: string,
  model = "google/gemini-embedding-001",
  apiKey?: string
) {
  if (!text.trim()) {
    return [];
  }

  const response = await createEmbeddingRequest(model, text, apiKey);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Embedding request failed: ${errorText}`);
  }

  const data = (await response.json()) as EmbeddingResponse;
  const embedding = data.data?.[0]?.embedding;
  if (!embedding) {
    throw new Error("Embedding response did not include an embedding vector.");
  }

  return embedding;
}
