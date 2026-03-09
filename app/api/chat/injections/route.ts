import { getChatInjectionById } from "@/lib/chatInjections";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id")?.trim() ?? "";

    if (!id) {
      return Response.json(
        { error: "Missing injection id." },
        { status: 400 }
      );
    }

    const injection = await getChatInjectionById(id);
    if (!injection) {
      return Response.json(
        { error: "Injection log not found." },
        { status: 404 }
      );
    }

    return Response.json(injection);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to load injection log.";
    return Response.json({ error: message }, { status: 500 });
  }
}
