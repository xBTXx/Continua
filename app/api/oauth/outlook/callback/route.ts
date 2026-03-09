import { exchangeCodeForToken, verifyStateToken } from "@/lib/outlookOAuth";
import { upsertOAuthToken } from "@/lib/oauthTokens";
import { withBasePath } from "@/lib/basePath";

const PROVIDER = "outlook";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  if (error) {
    return new Response(
      `Outlook OAuth error: ${error} ${errorDescription || ""}`.trim(),
      { status: 400 }
    );
  }

  if (!code || !state) {
    return new Response("Missing OAuth code or state.", { status: 400 });
  }

  const statePayload = verifyStateToken(state);
  if (!statePayload) {
    return new Response("Invalid OAuth state.", { status: 400 });
  }

  try {
    const tokenResponse = await exchangeCodeForToken(code);
    const expiresAt = new Date(Date.now() + tokenResponse.expires_in * 1000);

    await upsertOAuthToken({
      provider: PROVIDER,
      accountId: statePayload.accountId,
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token ?? null,
      expiresAt: expiresAt.toISOString(),
      scope: tokenResponse.scope,
      tokenType: tokenResponse.token_type,
    });

    const redirectUrl = new URL(withBasePath("/"), request.url);
    redirectUrl.searchParams.set("outlook", "connected");
    return Response.redirect(redirectUrl.toString());
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Outlook OAuth failed";
    return new Response(message, { status: 500 });
  }
}
