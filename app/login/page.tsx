import LoginForm from "@/components/LoginForm";
import { ensureAuthReady } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  let startupError: string | null = null;
  try {
    await ensureAuthReady();
  } catch (error) {
    startupError =
      error instanceof Error
        ? error.message
        : "Unable to initialize auth configuration.";
  }

  return <LoginForm startupError={startupError} />;
}
