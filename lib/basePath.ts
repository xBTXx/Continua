function normalizeBasePath(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed || trimmed === "/") {
    return "";
  }
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

const BASE_PATH = normalizeBasePath(process.env.NEXT_PUBLIC_BASE_PATH);

export function getBasePath(): string {
  return BASE_PATH;
}

export function withBasePath(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  if (BASE_PATH && (normalizedPath === BASE_PATH || normalizedPath.startsWith(`${BASE_PATH}/`))) {
    return normalizedPath;
  }
  if (normalizedPath === "/") {
    return BASE_PATH || "/";
  }
  return `${BASE_PATH}${normalizedPath}`;
}
