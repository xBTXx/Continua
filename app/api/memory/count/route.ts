import { countVectors } from "@/lib/vector";

export async function GET() {
  try {
    const count = await countVectors();
    return Response.json({ count });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected error";
    console.error("Memory count error:", message);
    return new Response(message, { status: 500 });
  }
}
