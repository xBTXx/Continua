import { generateEmbedding } from "@/lib/embeddings";

export async function POST(request: Request) {
  try {
    const payload = await request.json();
    const embedding = await generateEmbedding(
      payload.text,
      payload.model,
      payload.apiKey
    );
    return Response.json({ embedding });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected error";
    return new Response(message, { status: 500 });
  }
}
