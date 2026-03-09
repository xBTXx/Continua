import { getSystemPrompt, setSystemPrompt } from "@/lib/systemPrompt";

export async function GET() {
  try {
    const prompt = await getSystemPrompt();
    return Response.json({ prompt });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to load system prompt.";
    return new Response(message, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const payload = (await request.json().catch(() => ({}))) as {
      prompt?: string;
    };
    const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
    await setSystemPrompt(prompt);
    return new Response(null, { status: 204 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to update system prompt.";
    return new Response(message, { status: 500 });
  }
}
