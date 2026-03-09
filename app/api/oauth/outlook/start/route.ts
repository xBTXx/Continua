import { buildOutlookAuthUrl, createStateToken } from "@/lib/outlookOAuth";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const accountId = url.searchParams.get("account_id") || "owner";
    const state = createStateToken(accountId);
    const authUrl = buildOutlookAuthUrl(state);

    return Response.redirect(authUrl);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected OAuth error";
    return new Response(message, { status: 500 });
  }
}
