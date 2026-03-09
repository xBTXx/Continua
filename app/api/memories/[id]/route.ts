import { PERSONAL_MEMORY_COLLECTION } from "@/lib/personalMemory";
import { deleteVectors } from "@/lib/vector";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const rawId = id ? decodeURIComponent(id) : "";
  if (!rawId) {
    return new Response("Missing memory id.", { status: 400 });
  }

  try {
    const url = new URL(request.url);
    const scope = url.searchParams.get("scope");
    const collectionName =
      scope === "personal" ? PERSONAL_MEMORY_COLLECTION : undefined;
    await deleteVectors([rawId], collectionName);
    return Response.json({ status: "ok" });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to delete memory.";
    return new Response(message, { status: 500 });
  }
}
