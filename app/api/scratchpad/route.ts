import { deleteScratchpadNote, listScratchpadNotes } from "@/lib/scratchpad";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = Number(searchParams.get("limit") ?? "30");
    const offset = Number(searchParams.get("offset") ?? "0");
    const statusRaw = searchParams.get("status") ?? "active";
    const status =
      statusRaw === "consumed" || statusRaw === "all" ? statusRaw : "active";

    const data = await listScratchpadNotes({ limit, offset, status });
    return Response.json(data);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to load scratchpad notes.";
    return new Response(message, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const noteId = searchParams.get("id")?.trim() ?? "";
    if (!noteId) {
      return new Response("Scratchpad note id is required.", { status: 400 });
    }

    const deleted = await deleteScratchpadNote(noteId);
    if (deleted === 0) {
      return new Response("Scratchpad note not found.", { status: 404 });
    }
    return Response.json({ status: "ok", deleted });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to delete scratchpad note.";
    return new Response(message, { status: 500 });
  }
}
