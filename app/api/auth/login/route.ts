import { cookies } from "next/headers";
import { authenticateWithPassword, createSessionForUser, ensureAuthReady } from "@/lib/auth";
import { AUTH_COOKIE_NAME, getSessionTtlSeconds } from "@/lib/authSession";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    await ensureAuthReady();

    const body = (await request.json()) as {
      username?: unknown;
      password?: unknown;
    };

    const username = typeof body.username === "string" ? body.username : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (!username.trim() || !password) {
      return new Response("Login and password are required.", { status: 400 });
    }

    const user = await authenticateWithPassword(username, password);
    if (!user) {
      return new Response("Invalid login or password.", { status: 401 });
    }

    const token = await createSessionForUser(user);
    const cookieStore = await cookies();
    cookieStore.set({
      name: AUTH_COOKIE_NAME,
      value: token,
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: getSessionTtlSeconds(),
    });

    return Response.json({
      status: "ok",
      user: {
        username: user.username,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to perform login.";
    return new Response(message, { status: 500 });
  }
}
