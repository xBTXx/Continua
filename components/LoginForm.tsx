"use client";

import { FormEvent, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { withBasePath } from "@/lib/basePath";

type LoginFormProps = {
  startupError?: string | null;
};

function normalizeNextPath(value: string | null) {
  if (!value) {
    return "/";
  }
  if (!value.startsWith("/")) {
    return "/";
  }
  if (value.startsWith("//")) {
    return "/";
  }
  return value;
}

export default function LoginForm({ startupError }: LoginFormProps) {
  const searchParams = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(startupError ?? null);

  const nextPath = useMemo(
    () => normalizeNextPath(searchParams.get("next")),
    [searchParams]
  );

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (startupError) {
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(withBasePath("/api/auth/login"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          username,
          password,
        }),
      });

      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || "Invalid login or password.");
      }

      window.location.href = withBasePath(nextPath);
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Login request failed."
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-white px-6 py-8">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm rounded-2xl border border-black/10 bg-white p-6 shadow-[var(--shadow)]"
      >
        <p className="text-xs uppercase tracking-[0.24em] text-[var(--muted)]">
          Assistant Login
        </p>

        <div className="mt-5 space-y-3">
          <label className="block text-xs uppercase tracking-[0.16em] text-[var(--muted)]">
            Login
            <input
              type="text"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              className="mt-2 w-full rounded-xl border border-black/15 px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--green-500)]"
              disabled={submitting || Boolean(startupError)}
              required
            />
          </label>

          <label className="block text-xs uppercase tracking-[0.16em] text-[var(--muted)]">
            Password
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="mt-2 w-full rounded-xl border border-black/15 px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--green-500)]"
              disabled={submitting || Boolean(startupError)}
              required
            />
          </label>
        </div>

        {error && (
          <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}

        <button
          type="submit"
          className="mt-5 w-full rounded-xl border border-black/15 bg-[var(--ink)] px-4 py-2 text-sm uppercase tracking-[0.16em] text-white hover:bg-black disabled:cursor-not-allowed disabled:opacity-60"
          disabled={submitting || Boolean(startupError)}
        >
          {submitting ? "Signing in..." : "Sign in"}
        </button>
      </form>
    </main>
  );
}
