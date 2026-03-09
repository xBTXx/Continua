import path from "path";
import fs from "fs";
import {
    DEFAULT_WORKSPACE_ROOT,
    DEFAULT_RECYCLE_DAYS,
    DEFAULT_DOC_EXTENSIONS,
    CSV_EXTENSION,
    DEFAULT_ALLOW_ANY_DOC_EXTENSIONS,
    DEFAULT_ALLOW_ANY_SEARCH_EXTENSIONS,
    DEFAULT_SEARCHABLE_EXTENSIONS
} from "./constants";
import { ExtensionPolicy } from "./types";

export function docToolsEnabled() {
    return process.env.DOC_TOOLS_ENABLED !== "false";
}

export function csvToolsEnabled() {
    return process.env.CSV_TOOLS_ENABLED !== "false";
}

export function resolveWorkspaceRoot() {
    return path.resolve(
        process.env.ASSISTANT_WORKSPACE_ROOT ?? DEFAULT_WORKSPACE_ROOT
    );
}

export function getRecycleDays() {
    const raw = process.env.ASSISTANT_RECYCLE_DAYS;
    const parsed = raw ? Number(raw) : NaN;
    if (Number.isFinite(parsed) && parsed > 0) {
        return Math.floor(parsed);
    }
    return DEFAULT_RECYCLE_DAYS;
}

export function normalizeInputPath(input: string) {
    const trimmed = input.trim();
    if (!trimmed) {
        throw new Error("path is required.");
    }
    const withoutPrefix = trimmed.replace(/^[\\/]+/, "");
    if (!withoutPrefix) {
        return ".";
    }
    return path.normalize(withoutPrefix);
}

export function normalizeRelativePath(input: string) {
    const trimmed = input.trim();
    if (!trimmed) {
        return "";
    }
    try {
        const normalized = normalizeInputPath(trimmed);
        return normalized.split(path.sep).join("/");
    } catch {
        return "";
    }
}

export function parseExcludeDirs(value: unknown) {
    const items = Array.isArray(value)
        ? value
        : typeof value === "string"
            ? value.split(",")
            : [];
    const entries = items
        .map((entry) => (typeof entry === "string" ? normalizeRelativePath(entry) : ""))
        .filter(Boolean);
    return new Set(entries);
}

export function resolveWorkspacePath(input: string) {
    const root = resolveWorkspaceRoot();
    const relative = normalizeInputPath(input);
    const resolved = path.resolve(root, relative);
    const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    if (resolved !== root && !resolved.startsWith(rootWithSep)) {
        throw new Error("Path escapes workspace root.");
    }
    return resolved;
}

function isPathInside(basePath: string, targetPath: string) {
    const relative = path.relative(basePath, targetPath);
    return (
        relative === "" ||
        (!relative.startsWith("..") && !path.isAbsolute(relative))
    );
}

export function resolveDocInspectPath(input: string) {
    const trimmed = input.trim();
    if (!trimmed || trimmed === "/") {
        return resolveWorkspaceRoot();
    }

    const normalized = normalizeInputPath(trimmed);
    const workspaceCandidate = path.resolve(resolveWorkspaceRoot(), normalized);
    const cwdCandidate = path.resolve(process.cwd(), normalized);
    const absoluteCandidate = path.isAbsolute(trimmed)
        ? path.resolve(trimmed)
        : "";

    const candidates = Array.from(
        new Set(
            [workspaceCandidate, cwdCandidate, absoluteCandidate].filter(Boolean)
        )
    );

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    if (trimmed.startsWith("/") || path.isAbsolute(trimmed)) {
        return cwdCandidate;
    }
    return workspaceCandidate;
}

export function toWorkspaceRelative(absPath: string) {
    const root = resolveWorkspaceRoot();
    const relative = path.relative(root, absPath);
    if (!relative || relative === ".") {
        return "/";
    }
    return `/${relative.split(path.sep).join("/")}`;
}

export function toDocDisplayPath(absPath: string) {
    const workspaceRoot = resolveWorkspaceRoot();
    if (isPathInside(workspaceRoot, absPath)) {
        return toWorkspaceRelative(absPath);
    }

    const cwd = process.cwd();
    if (isPathInside(cwd, absPath)) {
        const relative = path.relative(cwd, absPath);
        if (!relative || relative === ".") {
            return ".";
        }
        return `./${relative.split(path.sep).join("/")}`;
    }

    return absPath;
}

export function toWorkspaceRelativeInput(inputPath: string) {
    return toWorkspaceRelative(resolveWorkspacePath(inputPath));
}

export function formatExtensionList(extensions: Set<string>) {
    return Array.from(extensions).sort().join(", ");
}

export function normalizeExtension(value: string) {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) {
        return "";
    }
    return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

export function parseExtensionList(value: string): ExtensionPolicy {
    const raw = value.trim();
    if (!raw) {
        return { allowAny: false, extensions: new Set<string>() };
    }
    const lowered = raw.toLowerCase();
    if (lowered === "*" || lowered === "all" || lowered === "any") {
        return { allowAny: true, extensions: new Set<string>() };
    }
    const parts = raw
        .split(",")
        .map((entry) => normalizeExtension(entry))
        .filter(Boolean);
    if (parts.some((entry) => entry === "*" || entry === ".*")) {
        return { allowAny: true, extensions: new Set<string>() };
    }
    return { allowAny: false, extensions: new Set(parts) };
}

export function parseExtensionsInput(value: unknown): ExtensionPolicy | null {
    if (Array.isArray(value)) {
        const parts = value
            .map((entry) => (typeof entry === "string" ? normalizeExtension(entry) : ""))
            .filter(Boolean);
        if (parts.some((entry) => entry === "*" || entry === ".*")) {
            return { allowAny: true, extensions: new Set<string>() };
        }
        return { allowAny: false, extensions: new Set(parts) };
    }
    if (typeof value === "string") {
        return parseExtensionList(value);
    }
    return null;
}

export function getDocExtensionPolicy(): ExtensionPolicy {
    const raw = process.env.DOC_ALLOWED_EXTENSIONS;
    if (!raw) {
        return {
            allowAny: DEFAULT_ALLOW_ANY_DOC_EXTENSIONS,
            extensions: DEFAULT_DOC_EXTENSIONS
        };
    }
    const parsed = parseExtensionList(raw);
    if (parsed.allowAny || parsed.extensions.size > 0) {
        return parsed;
    }
    return {
        allowAny: DEFAULT_ALLOW_ANY_DOC_EXTENSIONS,
        extensions: DEFAULT_DOC_EXTENSIONS
    };
}

export function getSearchExtensionPolicy(value: unknown): ExtensionPolicy {
    const parsed = parseExtensionsInput(value);
    if (parsed) {
        return parsed;
    }
    const env = process.env.DOC_SEARCH_EXTENSIONS;
    if (env) {
        const parsedEnv = parseExtensionList(env);
        if (parsedEnv.allowAny || parsedEnv.extensions.size > 0) {
            return parsedEnv;
        }
    }
    return {
        allowAny: DEFAULT_ALLOW_ANY_SEARCH_EXTENSIONS,
        extensions: DEFAULT_SEARCHABLE_EXTENSIONS
    };
}

export function assertDocFilePath(input: string) {
    const policy = getDocExtensionPolicy();
    if (policy.allowAny) {
        return;
    }
    const ext = path.extname(input).toLowerCase();
    if (!policy.extensions.has(ext)) {
        const allowed = formatExtensionList(policy.extensions);
        throw new Error(
            allowed
                ? `Only ${allowed} files are supported.`
                : "File extension is not allowed."
        );
    }
}

export function assertCsvFilePath(input: string) {
    const ext = path.extname(input).toLowerCase();
    if (ext !== CSV_EXTENSION) {
        throw new Error("Only .csv files are supported.");
    }
}

export function parsePositiveInt(value: unknown, fallback: number, min = 0) {
    const parsed =
        typeof value === "number" ? value : Number(value ?? Number.NaN);
    if (Number.isFinite(parsed) && parsed >= min) {
        return Math.floor(parsed);
    }
    return fallback;
}

export function normalizeTextEncoding(value: unknown): BufferEncoding {
    if (typeof value === "string" && value.trim().toLowerCase() === "base64") {
        return "base64";
    }
    return "utf8";
}

export function normalizeDelimiter(value: unknown) {
    if (typeof value === "string" && value.length > 0) {
        return value[0];
    }
    return ",";
}

export async function pathExists(filePath: string) {
    try {
        await fs.promises.lstat(filePath);
        return true;
    } catch {
        return false;
    }
}

export function toStringValue(value: unknown) {
    if (value === null || value === undefined) {
        return "";
    }
    if (typeof value === "string") {
        return value;
    }
    return String(value);
}
