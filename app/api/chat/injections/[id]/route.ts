import { getChatInjectionById } from "@/lib/chatInjections";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
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
