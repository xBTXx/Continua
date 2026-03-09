import { generatePersonaProfile, getPersonaProfile, setPersonaProfile } from "@/lib/persona";

type PersonaPayload = {
  persona?: string;
  apiKey?: string;
  appUrl?: string;
  maxMemories?: number;
};

export async function GET() {
  try {
    const persona = await getPersonaProfile();
    return Response.json({ persona });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to load persona profile.";
    return new Response(message, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const payload = (await request.json().catch(() => ({}))) as PersonaPayload;
    const persona = typeof payload.persona === "string" ? payload.persona : "";
    await setPersonaProfile(persona);
    return new Response(null, { status: 204 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to update persona profile.";
    return new Response(message, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json().catch(() => ({}))) as PersonaPayload;
    const apiKey = typeof payload.apiKey === "string" ? payload.apiKey : undefined;
    const appUrl = typeof payload.appUrl === "string" ? payload.appUrl : undefined;
    const maxMemories =
      typeof payload.maxMemories === "number" ? payload.maxMemories : undefined;

    const result = await generatePersonaProfile({ apiKey, appUrl, maxMemories });
    return Response.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Persona refinement failed.";
    return new Response(message, { status: 500 });
  }
}
