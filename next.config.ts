import type { NextConfig } from "next";

function normalizeBasePath(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed || trimmed === "/") {
    return "";
  }
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

const nextConfig: NextConfig = {
  basePath: normalizeBasePath(process.env.NEXT_PUBLIC_BASE_PATH),
};

export default nextConfig;
