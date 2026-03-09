import fs from "fs";
import path from "path";
import {
    normalizeInputPath,
    assertDocFilePath,
    resolveWorkspacePath,
    resolveDocInspectPath,
    normalizeTextEncoding,
    toDocDisplayPath,
    toWorkspaceRelative,
    parsePositiveInt,
    getSearchExtensionPolicy,
    parseExcludeDirs,
    resolveWorkspaceRoot,
    pathExists,
    toStringValue
} from "./utils";
import {
    DEFAULT_MAX_READ_BYTES,
    DEFAULT_LIST_LIMIT,
    DEFAULT_SEARCH_LIMIT,
    DEFAULT_MAX_SEARCH_BYTES
} from "./constants";
import { ensureWorkspaceRoot, moveToRecycle } from "./recycle";
import {
    applyUnifiedHunksToText,
    normalizeUnifiedDiffPath,
    parseUnifiedDiffPatch
} from "./unifiedPatch";

export async function readFileLimited(
    filePath: string,
    maxBytes: number,
    offset = 0,
    encoding: BufferEncoding = "utf8"
) {
    const stats = await fs.promises.stat(filePath);
    if (!stats.isFile()) {
        throw new Error("Path is not a file.");
    }
    if (offset < 0) {
        throw new Error("offset must be >= 0.");
    }
    if (offset > stats.size) {
        throw new Error("offset exceeds file size.");
    }
    const available = stats.size - offset;
    const bytesToRead = Math.min(available, maxBytes);
    const handle = await fs.promises.open(filePath, "r");
    try {
        const buffer = Buffer.alloc(bytesToRead);
        const { bytesRead } = await handle.read(buffer, 0, bytesToRead, offset);
        return {
            content: buffer.toString(encoding, 0, bytesRead),
            truncated: offset + bytesRead < stats.size,
            size: stats.size,
            modifiedAt: stats.mtime.toISOString(),
            offset,
            bytesRead,
        };
    } finally {
        await handle.close();
    }
}

export function findNthIndex(source: string, target: string, occurrence: number) {
    if (!target) {
        return -1;
    }
    let index = -1;
    let fromIndex = 0;
    for (let count = 0; count < occurrence; count += 1) {
        index = source.indexOf(target, fromIndex);
        if (index === -1) {
            return -1;
        }
        fromIndex = index + target.length;
    }
    return index;
}

export async function docCreateFile(args: Record<string, unknown>) {
    try {
        const inputPath = toStringValue(args.path);
        const relative = normalizeInputPath(inputPath);
        assertDocFilePath(relative);
        const filePath = resolveWorkspacePath(inputPath);
        const content = toStringValue(args.content);
        const encoding = normalizeTextEncoding(args.encoding);
        const overwrite = Boolean(args.overwrite);
        await ensureWorkspaceRoot();
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        try {
            const existing = await fs.promises.stat(filePath);
            if (existing.isFile() && !overwrite) {
                return { error: "File already exists. Set overwrite to true to replace." };
            }
            if (existing.isDirectory()) {
                return { error: "A directory exists at that path." };
            }
        } catch {
            // file does not exist
        }
        const payload =
            encoding === "base64" ? Buffer.from(content, "base64") : content;
        await fs.promises.writeFile(filePath, payload);
        return {
            success: true,
            path: toWorkspaceRelative(filePath),
            bytes: Buffer.isBuffer(payload)
                ? payload.byteLength
                : Buffer.byteLength(content, encoding),
            encoding,
        };
    } catch (error) {
        return {
            error: error instanceof Error ? error.message : "Failed to create file.",
        };
    }
}

export async function docReadFile(args: Record<string, unknown>) {
    try {
        const inputPath = toStringValue(args.path);
        const relative = normalizeInputPath(inputPath);
        assertDocFilePath(relative);
        const filePath = resolveDocInspectPath(inputPath);
        const maxBytes = parsePositiveInt(
            args.max_bytes,
            DEFAULT_MAX_READ_BYTES,
            1
        );
        const offset = parsePositiveInt(args.offset, 0, 0);
        const encoding = normalizeTextEncoding(args.encoding);
        const { content, truncated, size, modifiedAt, bytesRead } =
            await readFileLimited(filePath, maxBytes, offset, encoding);
        return {
            path: toDocDisplayPath(filePath),
            content,
            bytes: size,
            truncated,
            modified_at: modifiedAt,
            offset,
            bytes_read: bytesRead,
            encoding,
        };
    } catch (error) {
        return {
            error: error instanceof Error ? error.message : "Failed to read file.",
        };
    }
}

export async function docUpdateFile(args: Record<string, unknown>) {
    try {
        const inputPath = toStringValue(args.path);
        const relative = normalizeInputPath(inputPath);
        assertDocFilePath(relative);
        const filePath = resolveWorkspacePath(inputPath);
        const mode = toStringValue(args.mode);
        if (!mode) {
            return { error: "mode is required." };
        }
        const hasContent = args.content !== undefined;
        const content = toStringValue(args.content);
        const encoding = normalizeTextEncoding(args.encoding);
        const createIfMissing = Boolean(args.create_if_missing);

        if (mode === "append") {
            if (!hasContent) {
                return { error: "append mode requires content." };
            }
            await ensureWorkspaceRoot();
            await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
            try {
                await fs.promises.stat(filePath);
            } catch {
                if (!createIfMissing) {
                    return { error: "File does not exist. Set create_if_missing to true." };
                }
            }
            const payload =
                encoding === "base64" ? Buffer.from(content, "base64") : content;
            await fs.promises.appendFile(filePath, payload);
        } else if (mode === "overwrite") {
            if (!hasContent) {
                return { error: "overwrite mode requires content." };
            }
            await ensureWorkspaceRoot();
            await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
            const payload =
                encoding === "base64" ? Buffer.from(content, "base64") : content;
            await fs.promises.writeFile(filePath, payload);
        } else if (mode === "replace") {
            if (encoding !== "utf8") {
                return { error: "replace mode only supports utf8 content." };
            }
            const find = toStringValue(args.find);
            const replace = toStringValue(args.replace);
            if (!find) {
                return { error: "replace mode requires find text." };
            }
            const occurrence = Math.max(
                1,
                parsePositiveInt(args.occurrence, 1, 1)
            );
            const replaceAll = Boolean(args.replace_all);
            const existing = await fs.promises.readFile(filePath, "utf8");
            let updated = "";
            let replacedCount = 0;
            if (replaceAll) {
                updated = existing.split(find).join(replace);
                replacedCount = existing.split(find).length - 1;
            } else {
                const index = findNthIndex(existing, find, occurrence);
                if (index === -1) {
                    return { error: "Target text not found." };
                }
                updated =
                    existing.slice(0, index) +
                    replace +
                    existing.slice(index + find.length);
                replacedCount = 1;
            }
            await fs.promises.writeFile(filePath, updated, "utf8");
            return {
                success: true,
                path: toWorkspaceRelative(filePath),
                mode,
                replaced_count: replacedCount,
            };
        } else if (mode === "replace_regex") {
            if (encoding !== "utf8") {
                return { error: "replace_regex mode only supports utf8 content." };
            }
            const pattern = toStringValue(args.pattern);
            const replace = toStringValue(args.replace);
            if (!pattern) {
                return { error: "replace_regex mode requires pattern." };
            }
            const replaceAll = Boolean(args.replace_all);
            const rawFlags = toStringValue(args.flags);
            let flags = rawFlags;
            if (replaceAll && !flags.includes("g")) {
                flags += "g";
            }
            const countFlags = flags.includes("g") ? flags : `${flags}g`;
            let regex: RegExp;
            let countRegex: RegExp;
            try {
                regex = new RegExp(pattern, flags);
                countRegex = new RegExp(pattern, countFlags);
            } catch {
                return { error: "Invalid regex pattern or flags." };
            }
            const existing = await fs.promises.readFile(filePath, "utf8");
            const matches = existing.match(countRegex);
            const replacedCount = matches ? matches.length : 0;
            const updated = existing.replace(regex, replace);
            await fs.promises.writeFile(filePath, updated, "utf8");
            return {
                success: true,
                path: toWorkspaceRelative(filePath),
                mode,
                replaced_count: replacedCount,
            };
        } else if (mode === "insert_before" || mode === "insert_after") {
            if (!hasContent) {
                return { error: "insert mode requires content." };
            }
            if (encoding !== "utf8") {
                return { error: "insert mode only supports utf8 content." };
            }
            const target = toStringValue(args.target);
            if (!target) {
                return { error: "insert mode requires target text." };
            }
            const occurrence = Math.max(
                1,
                parsePositiveInt(args.occurrence, 1, 1)
            );
            const existing = await fs.promises.readFile(filePath, "utf8");
            const index = findNthIndex(existing, target, occurrence);
            if (index === -1) {
                return { error: "Target text not found." };
            }
            const insertAt =
                mode === "insert_before" ? index : index + target.length;
            const updated =
                existing.slice(0, insertAt) + content + existing.slice(insertAt);
            await fs.promises.writeFile(filePath, updated, "utf8");
        } else if (mode === "insert_at") {
            if (!hasContent) {
                return { error: "insert_at mode requires content." };
            }
            if (encoding !== "utf8") {
                return { error: "insert_at mode only supports utf8 content." };
            }
            if (args.index === undefined) {
                return { error: "insert_at mode requires index." };
            }
            const index = parsePositiveInt(args.index, 0, 0);
            const existing = await fs.promises.readFile(filePath, "utf8");
            if (index > existing.length) {
                return { error: "insert_at index exceeds file length." };
            }
            const updated =
                existing.slice(0, index) + content + existing.slice(index);
            await fs.promises.writeFile(filePath, updated, "utf8");
        } else if (mode === "replace_range") {
            if (!hasContent) {
                return { error: "replace_range mode requires content." };
            }
            if (encoding !== "utf8") {
                return { error: "replace_range mode only supports utf8 content." };
            }
            if (args.start === undefined) {
                return { error: "replace_range mode requires start." };
            }
            const start = parsePositiveInt(args.start, 0, 0);
            const length = parsePositiveInt(args.length, 0, 0);
            const end = args.end !== undefined ? parsePositiveInt(args.end, start, 0) : start + length;
            if (end < start) {
                return { error: "replace_range end must be >= start." };
            }
            const existing = await fs.promises.readFile(filePath, "utf8");
            if (start > existing.length) {
                return { error: "replace_range start exceeds file length." };
            }
            const clampedEnd = Math.min(end, existing.length);
            const updated =
                existing.slice(0, start) + content + existing.slice(clampedEnd);
            await fs.promises.writeFile(filePath, updated, "utf8");
        } else {
            return { error: "Unknown update mode." };
        }

        const stats = await fs.promises.stat(filePath);
        return {
            success: true,
            path: toWorkspaceRelative(filePath),
            mode,
            bytes: stats.size,
            modified_at: stats.mtime.toISOString(),
            encoding,
        };
    } catch (error) {
        return {
            error: error instanceof Error ? error.message : "Failed to update file.",
        };
    }
}

export async function docApplyPatch(args: Record<string, unknown>) {
    try {
        const patch = toStringValue(args.patch);
        if (!patch.trim()) {
            return { error: "patch is required." };
        }

        const strip =
            args.strip === undefined
                ? null
                : parsePositiveInt(args.strip, 0, 0);
        const constrainedPathInput = toStringValue(args.path);
        const constrainedPath = constrainedPathInput
            ? normalizeInputPath(constrainedPathInput)
            : "";
        if (constrainedPath) {
            assertDocFilePath(constrainedPath);
        }

        await ensureWorkspaceRoot();
        const filePatches = parseUnifiedDiffPatch(patch);
        const stagedByPath = new Map<
            string,
            {
                relativePath: string;
                content: string;
                hunksApplied: number;
                changed: boolean;
            }
        >();

        for (const filePatch of filePatches) {
            if (filePatch.hunks.length === 0) {
                return {
                    error:
                        "Patch contains a file entry without hunks. Only text hunks are supported.",
                };
            }

            const oldPath = normalizeUnifiedDiffPath(filePatch.oldPathRaw, strip);
            const newPath = normalizeUnifiedDiffPath(filePatch.newPathRaw, strip);
            if (oldPath === "/dev/null" || newPath === "/dev/null") {
                return {
                    error:
                        "doc_apply_patch supports modifications to existing files only (no create/delete).",
                };
            }
            if (oldPath !== newPath) {
                return {
                    error: "doc_apply_patch does not support file renames.",
                };
            }

            const relativePath = normalizeInputPath(newPath);
            assertDocFilePath(relativePath);
            if (constrainedPath && relativePath !== constrainedPath) {
                return {
                    error: `Patch touches /${relativePath}, but path is constrained to /${constrainedPath}.`,
                };
            }
            const filePath = resolveWorkspacePath(relativePath);

            const staged = stagedByPath.get(filePath);
            let baseContent = "";
            if (staged) {
                baseContent = staged.content;
            } else {
                const stats = await fs.promises.stat(filePath);
                if (!stats.isFile()) {
                    return { error: `Path is not a file: /${relativePath}` };
                }
                baseContent = await fs.promises.readFile(filePath, "utf8");
            }

            const applied = applyUnifiedHunksToText({
                originalContent: baseContent,
                hunks: filePatch.hunks,
                fileLabel: `/${relativePath}`,
            });
            const nextContent = applied.content;
            const previousChanged = staged?.changed ?? false;
            stagedByPath.set(filePath, {
                relativePath,
                content: nextContent,
                hunksApplied: (staged?.hunksApplied ?? 0) + applied.hunksApplied,
                changed: previousChanged || nextContent !== baseContent,
            });
        }

        const files: Array<{
            path: string;
            hunks_applied: number;
            bytes: number;
            modified_at: string;
        }> = [];
        for (const [filePath, staged] of stagedByPath) {
            if (!staged.changed) {
                continue;
            }
            await fs.promises.writeFile(filePath, staged.content, "utf8");
            const stats = await fs.promises.stat(filePath);
            files.push({
                path: toWorkspaceRelative(filePath),
                hunks_applied: staged.hunksApplied,
                bytes: stats.size,
                modified_at: stats.mtime.toISOString(),
            });
        }

        const totalHunks = Array.from(stagedByPath.values()).reduce(
            (sum, entry) => sum + entry.hunksApplied,
            0
        );
        return {
            success: true,
            file_count: files.length,
            hunk_count: totalHunks,
            files,
            unchanged_file_count: stagedByPath.size - files.length,
        };
    } catch (error) {
        return {
            error: error instanceof Error ? error.message : "Failed to apply patch.",
        };
    }
}

type BulkAction = "search" | "move" | "copy" | "replace";
type BulkSearchMode = "name" | "content" | "both";
type BulkMatchReason = "metadata" | "name" | "content";

type BulkMatch = {
    absolutePath: string;
    displayPath: string;
    relativeToRoot: string;
    name: string;
    sizeBytes: number;
    modifiedAt: string;
    createdAt: string;
    matchedOn: BulkMatchReason[];
    snippet?: string;
    line?: number;
    column?: number;
    contentMatchCount?: number;
};

function parseNonNegativeInt(value: unknown) {
    if (value === undefined || value === null || value === "") {
        return null;
    }
    const parsed =
        typeof value === "number" ? value : Number(value ?? Number.NaN);
    if (Number.isFinite(parsed) && parsed >= 0) {
        return Math.floor(parsed);
    }
    throw new Error("Expected a non-negative integer.");
}

function normalizeBulkAction(value: unknown): BulkAction | null {
    const action = toStringValue(value).trim().toLowerCase();
    if (
        action === "search" ||
        action === "move" ||
        action === "copy" ||
        action === "replace"
    ) {
        return action;
    }
    return null;
}

function normalizeBulkMode(value: unknown, fallback: BulkSearchMode): BulkSearchMode {
    const mode = toStringValue(value).trim().toLowerCase();
    if (mode === "name" || mode === "content" || mode === "both") {
        return mode;
    }
    return fallback;
}

function mergeRegexFlags(rawFlags: string, extras: string[]) {
    const merged = new Set(rawFlags.split("").filter(Boolean));
    extras.forEach((flag) => {
        if (flag) {
            merged.add(flag);
        }
    });
    return Array.from(merged).join("");
}

function escapeRegexLiteral(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countLiteralOccurrences(source: string, target: string) {
    if (!target) {
        return 0;
    }
    let count = 0;
    let index = 0;
    while (true) {
        const foundAt = source.indexOf(target, index);
        if (foundAt === -1) {
            return count;
        }
        count += 1;
        index = foundAt + Math.max(target.length, 1);
    }
}

function isPathInside(basePath: string, targetPath: string) {
    const relative = path.relative(basePath, targetPath);
    return (
        relative === "" ||
        (!relative.startsWith("..") && !path.isAbsolute(relative))
    );
}

function isHiddenPathSegment(name: string) {
    return name.startsWith(".");
}

function matchesTimeWindow(
    stats: fs.Stats,
    modifiedWithinHours: number | null,
    createdWithinHours: number | null,
    nowMs: number
) {
    if (
        modifiedWithinHours !== null &&
        nowMs - stats.mtimeMs > modifiedWithinHours * 60 * 60 * 1000
    ) {
        return false;
    }
    if (
        createdWithinHours !== null &&
        nowMs - stats.birthtimeMs > createdWithinHours * 60 * 60 * 1000
    ) {
        return false;
    }
    return true;
}

function analyzeRegexMatch(content: string, regex: RegExp) {
    const matcher = new RegExp(regex.source, mergeRegexFlags(regex.flags, ["g"]));
    let firstMatch: RegExpExecArray | null = null;
    let count = 0;
    while (true) {
        const match = matcher.exec(content);
        if (!match) {
            break;
        }
        if (!firstMatch) {
            firstMatch = match;
        }
        count += 1;
        if (match[0] === "") {
            matcher.lastIndex += 1;
        }
    }
    return {
        index: typeof firstMatch?.index === "number" ? firstMatch.index : -1,
        matchText: firstMatch?.[0] ?? "",
        count,
    };
}

function buildSnippet(content: string, index: number, matchText: string) {
    const snippetStart = Math.max(0, index - 60);
    const snippetEnd = Math.min(
        content.length,
        index + Math.max(matchText.length, 1) + 60
    );
    const prefix = content.slice(0, index);
    const lines = prefix.split(/\r\n|\r|\n/);
    return {
        snippet: content.slice(snippetStart, snippetEnd).replace(/\s+/g, " "),
        line: lines.length,
        column: (lines[lines.length - 1] ?? "").length + 1,
    };
}

async function copyWorkspaceEntry(
    sourcePath: string,
    destinationPath: string,
    overwrite: boolean
) {
    const stats = await fs.promises.lstat(sourcePath);
    if (stats.isDirectory()) {
        throw new Error("Bulk copy currently supports files only.");
    }
    if (await pathExists(destinationPath)) {
        if (!overwrite) {
            throw new Error("Destination already exists. Set overwrite to true.");
        }
        await moveToRecycle(destinationPath);
    }
    await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.promises.copyFile(sourcePath, destinationPath);
}

async function collectBulkMatches(args: {
    searchRoot: string;
    pathForDisplay: string;
    mode: BulkSearchMode;
    query: string;
    useRegex: boolean;
    regexFlags: string;
    caseSensitive: boolean;
    includeHidden: boolean;
    includeTrash: boolean;
    limit: number;
    offset: number;
    maxBytes: number;
    maxDepth: number;
    extensionPolicy: ReturnType<typeof getSearchExtensionPolicy>;
    excludeDirs: Set<string>;
    modifiedWithinHours: number | null;
    createdWithinHours: number | null;
}) {
    const {
        searchRoot,
        pathForDisplay,
        mode,
        query,
        useRegex,
        regexFlags,
        caseSensitive,
        includeHidden,
        includeTrash,
        limit,
        offset,
        maxBytes,
        maxDepth,
        extensionPolicy,
        excludeDirs,
        modifiedWithinHours,
        createdWithinHours,
    } = args;
    const stats = await fs.promises.stat(searchRoot);
    const rootIsFile = stats.isFile();
    const queryEnabled = query.length > 0;
    const nowMs = Date.now();
    let queryRegex: RegExp | null = null;
    if (queryEnabled && useRegex) {
        try {
            queryRegex = new RegExp(
                query,
                mergeRegexFlags(regexFlags, caseSensitive ? [] : ["i"])
            );
        } catch {
            throw new Error("Invalid regex pattern or flags.");
        }
    }
    const literalNeedle = caseSensitive ? query : query.toLowerCase();

    const matches: BulkMatch[] = [];
    let matchedCount = 0;
    let scannedFileCount = 0;
    let truncated = false;

    const maybeRegisterMatch = (match: BulkMatch) => {
        matchedCount += 1;
        if (matchedCount <= offset) {
            return;
        }
        if (matches.length >= limit) {
            truncated = true;
            return;
        }
        matches.push(match);
    };

    const analyzeFile = async (filePath: string) => {
        if (matches.length >= limit) {
            truncated = true;
            return;
        }
        scannedFileCount += 1;
        const basename = path.basename(filePath);
        const ext = path.extname(filePath).toLowerCase();
        if (!extensionPolicy.allowAny && !extensionPolicy.extensions.has(ext)) {
            return;
        }

        const stat = await fs.promises.stat(filePath);
        if (
            !matchesTimeWindow(
                stat,
                modifiedWithinHours,
                createdWithinHours,
                nowMs
            )
        ) {
            return;
        }

        const matchedOn: BulkMatchReason[] = [];
        let snippet: string | undefined;
        let line: number | undefined;
        let column: number | undefined;
        let contentMatchCount: number | undefined;

        if (queryEnabled && (mode === "name" || mode === "both")) {
            const nameMatched = queryRegex
                ? queryRegex.test(basename)
                : (caseSensitive ? basename : basename.toLowerCase()).includes(
                    literalNeedle
                );
            if (queryRegex) {
                queryRegex.lastIndex = 0;
            }
            if (nameMatched) {
                matchedOn.push("name");
            }
        }

        if (queryEnabled && (mode === "content" || mode === "both")) {
            if (stat.size <= maxBytes) {
                const content = await fs.promises.readFile(filePath, "utf8");
                let matchIndex = -1;
                let matchText = "";
                let occurrences = 0;
                if (queryRegex) {
                    const regexAnalysis = analyzeRegexMatch(content, queryRegex);
                    matchIndex = regexAnalysis.index;
                    matchText = regexAnalysis.matchText;
                    occurrences = regexAnalysis.count;
                } else {
                    const haystack = caseSensitive ? content : content.toLowerCase();
                    matchIndex = haystack.indexOf(literalNeedle);
                    matchText =
                        matchIndex === -1
                            ? ""
                            : content.slice(matchIndex, matchIndex + query.length);
                    occurrences = countLiteralOccurrences(haystack, literalNeedle);
                }
                if (matchIndex !== -1) {
                    matchedOn.push("content");
                    const snippetData = buildSnippet(content, matchIndex, matchText);
                    snippet = snippetData.snippet;
                    line = snippetData.line;
                    column = snippetData.column;
                    contentMatchCount = occurrences;
                }
            }
        }

        if (!queryEnabled) {
            matchedOn.push("metadata");
        }

        if (matchedOn.length === 0) {
            return;
        }

        const relativeToRoot = rootIsFile
            ? basename
            : path.relative(searchRoot, filePath).split(path.sep).join("/");
        maybeRegisterMatch({
            absolutePath: filePath,
            displayPath: pathForDisplay === "workspace"
                ? toWorkspaceRelative(filePath)
                : toDocDisplayPath(filePath),
            relativeToRoot,
            name: basename,
            sizeBytes: stat.size,
            modifiedAt: stat.mtime.toISOString(),
            createdAt: stat.birthtime.toISOString(),
            matchedOn,
            snippet,
            line,
            column,
            contentMatchCount,
        });
    };

    if (stats.isFile()) {
        await analyzeFile(searchRoot);
    } else {
        const queue: Array<{ directory: string; depth: number }> = [
            { directory: searchRoot, depth: 0 },
        ];
        while (queue.length > 0) {
            const current = queue.shift();
            if (!current) {
                break;
            }
            const dirents = await fs.promises.readdir(current.directory, {
                withFileTypes: true,
            });
            for (const entry of dirents) {
                if (!includeHidden && isHiddenPathSegment(entry.name)) {
                    if (!includeTrash && entry.name === ".recycle_bin") {
                        continue;
                    }
                    if (entry.name !== ".recycle_bin") {
                        continue;
                    }
                }
                if (!includeTrash && entry.name === ".recycle_bin") {
                    continue;
                }
                const fullPath = path.join(current.directory, entry.name);
                const relativeToSearchRoot = path
                    .relative(searchRoot, fullPath)
                    .split(path.sep)
                    .join("/");
                if (
                    entry.isDirectory() &&
                    (excludeDirs.has(entry.name) ||
                        excludeDirs.has(relativeToSearchRoot))
                ) {
                    continue;
                }
                if (entry.isDirectory()) {
                    if (current.depth < maxDepth) {
                        queue.push({
                            directory: fullPath,
                            depth: current.depth + 1,
                        });
                    }
                    continue;
                }
                await analyzeFile(fullPath);
            }
        }
    }

    return {
        matches,
        matchedCount,
        scannedFileCount,
        truncated,
    };
}

export async function fsBulkManager(args: Record<string, unknown>) {
    try {
        const action = normalizeBulkAction(args.action);
        if (!action) {
            return { error: "action must be search, move, copy, or replace." };
        }

        const inputPath = toStringValue(args.path || "/");
        const mode =
            action === "replace"
                ? "content"
                : normalizeBulkMode(args.mode, "both");

        const query = toStringValue(args.query);
        const caseSensitive = Boolean(args.case_sensitive);
        const includeHidden = Boolean(args.include_hidden);
        const includeTrash = Boolean(args.include_trash);
        const limit = parsePositiveInt(args.limit, DEFAULT_SEARCH_LIMIT, 1);
        const offset = parsePositiveInt(args.offset, 0, 0);
        const maxBytes = parsePositiveInt(
            args.max_file_bytes,
            DEFAULT_MAX_SEARCH_BYTES,
            1
        );
        const maxDepth =
            args.max_depth === undefined
                ? Number.POSITIVE_INFINITY
                : parsePositiveInt(args.max_depth, 0, 0);
        const useRegex = Boolean(args.use_regex);
        const regexFlags = toStringValue(args.flags);
        const extensionPolicy = getSearchExtensionPolicy(args.extensions);
        const excludeDirs = parseExcludeDirs(args.exclude_dirs);
        const modifiedWithinHours = parseNonNegativeInt(args.modified_within_hours);
        const createdWithinHours = parseNonNegativeInt(args.created_within_hours);

        const searchRoot =
            action === "search"
                ? resolveDocInspectPath(inputPath)
                : resolveWorkspacePath(inputPath);

        const destinationInput = toStringValue(args.destination_path);
        const apply = Boolean(args.apply);
        let destinationRoot = "";
        if (action === "move" || action === "copy") {
            if (!destinationInput) {
                return { error: "destination_path is required for move/copy." };
            }
            destinationRoot = resolveWorkspacePath(destinationInput);
            if (isPathInside(searchRoot, destinationRoot)) {
                const relativeDestination = path
                    .relative(searchRoot, destinationRoot)
                    .split(path.sep)
                    .join("/");
                if (relativeDestination) {
                    excludeDirs.add(relativeDestination);
                }
            }
        }

        const matchData = await collectBulkMatches({
            searchRoot,
            pathForDisplay: action === "search" ? "inspect" : "workspace",
            mode,
            query,
            useRegex,
            regexFlags,
            caseSensitive,
            includeHidden,
            includeTrash,
            limit,
            offset,
            maxBytes,
            maxDepth,
            extensionPolicy,
            excludeDirs,
            modifiedWithinHours,
            createdWithinHours,
        });

        if (action === "search") {
            return {
                action,
                path: toDocDisplayPath(searchRoot),
                query,
                mode,
                matches: matchData.matches.map((match) => ({
                    path: match.displayPath,
                    name: match.name,
                    size_bytes: match.sizeBytes,
                    modified_at: match.modifiedAt,
                    created_at: match.createdAt,
                    matched_on: match.matchedOn,
                    snippet: match.snippet,
                    line: match.line,
                    column: match.column,
                    content_match_count: match.contentMatchCount,
                })),
                scanned_file_count: matchData.scannedFileCount,
                matched_file_count: matchData.matchedCount,
                truncated: matchData.truncated,
                offset,
                limit,
            };
        }

        if (action === "move" || action === "copy") {
            const overwrite = Boolean(args.overwrite);
            const preserveStructure = args.preserve_structure !== false;
            const operations: Array<Record<string, unknown>> = [];
            let executedCount = 0;
            let skippedCount = 0;

            for (const match of matchData.matches) {
                const relativeTarget = preserveStructure
                    ? match.relativeToRoot
                    : path.basename(match.absolutePath);
                const destinationPath = path.resolve(destinationRoot, relativeTarget);
                if (!isPathInside(destinationRoot, destinationPath)) {
                    skippedCount += 1;
                    operations.push({
                        from: match.displayPath,
                        to: toWorkspaceRelative(destinationPath),
                        status: "skipped",
                        reason: "Destination escapes destination_path.",
                    });
                    continue;
                }
                if (destinationPath === match.absolutePath) {
                    skippedCount += 1;
                    operations.push({
                        from: match.displayPath,
                        to: toWorkspaceRelative(destinationPath),
                        status: "skipped",
                        reason: "Source and destination are the same.",
                    });
                    continue;
                }
                const destinationExists = await pathExists(destinationPath);
                if (destinationExists && !overwrite) {
                    skippedCount += 1;
                    operations.push({
                        from: match.displayPath,
                        to: toWorkspaceRelative(destinationPath),
                        status: apply ? "skipped" : "conflict",
                        reason: "Destination already exists. Set overwrite=true.",
                    });
                    continue;
                }
                if (!apply) {
                    operations.push({
                        from: match.displayPath,
                        to: toWorkspaceRelative(destinationPath),
                        status: "preview",
                    });
                    continue;
                }
                try {
                    if (action === "move") {
                        await moveWorkspacePath(
                            match.absolutePath,
                            destinationPath,
                            overwrite
                        );
                    } else {
                        await copyWorkspaceEntry(
                            match.absolutePath,
                            destinationPath,
                            overwrite
                        );
                    }
                    executedCount += 1;
                    operations.push({
                        from: match.displayPath,
                        to: toWorkspaceRelative(destinationPath),
                        status: "success",
                    });
                } catch (error) {
                    skippedCount += 1;
                    operations.push({
                        from: match.displayPath,
                        to: toWorkspaceRelative(destinationPath),
                        status: "error",
                        reason:
                            error instanceof Error
                                ? error.message
                                : `Failed to ${action} file.`,
                    });
                }
            }

            return {
                action,
                path: toWorkspaceRelative(searchRoot),
                destination_path: toWorkspaceRelative(destinationRoot),
                preview: !apply,
                preserve_structure: preserveStructure,
                overwrite,
                scanned_file_count: matchData.scannedFileCount,
                matched_file_count: matchData.matchedCount,
                affected_file_count: apply ? executedCount : operations.length,
                skipped_file_count: skippedCount,
                truncated: matchData.truncated,
                operations,
            };
        }

        if (!query) {
            return { error: "replace requires query." };
        }
        if (
            !Object.prototype.hasOwnProperty.call(args, "replace") &&
            !Object.prototype.hasOwnProperty.call(args, "replacement")
        ) {
            return { error: "replace action requires replace text." };
        }
        const replaceText =
            args.replace !== undefined
                ? toStringValue(args.replace)
                : toStringValue(args.replacement);
        const replaceAll = args.replace_all !== false;
        const operations: Array<Record<string, unknown>> = [];
        let executedCount = 0;

        let replacementRegex: RegExp;
        try {
            replacementRegex = useRegex
                ? new RegExp(
                    query,
                    mergeRegexFlags(
                        regexFlags,
                        [
                            ...(replaceAll ? ["g"] : []),
                            ...(caseSensitive ? [] : ["i"]),
                        ]
                    )
                )
                : new RegExp(
                    escapeRegexLiteral(query),
                    mergeRegexFlags("", [
                        ...(replaceAll ? ["g"] : []),
                        ...(caseSensitive ? [] : ["i"]),
                    ])
                );
        } catch {
            return { error: "Invalid regex pattern or flags." };
        }

        for (const match of matchData.matches) {
            const currentContent = await fs.promises.readFile(match.absolutePath, "utf8");
            const replacementCount = analyzeRegexMatch(
                currentContent,
                replacementRegex
            ).count;
            if (replacementCount === 0) {
                continue;
            }
            if (!apply) {
                operations.push({
                    path: match.displayPath,
                    status: "preview",
                    replaced_count: replacementCount,
                    snippet: match.snippet,
                    line: match.line,
                    column: match.column,
                });
                continue;
            }
            const nextContent = useRegex
                ? currentContent.replace(replacementRegex, replaceText)
                : currentContent.replace(replacementRegex, () => replaceText);
            await fs.promises.writeFile(match.absolutePath, nextContent, "utf8");
            const updatedStats = await fs.promises.stat(match.absolutePath);
            executedCount += 1;
            operations.push({
                path: match.displayPath,
                status: "success",
                replaced_count: replacementCount,
                bytes: updatedStats.size,
                modified_at: updatedStats.mtime.toISOString(),
            });
        }

        return {
            action,
            path: toWorkspaceRelative(searchRoot),
            preview: !apply,
            query,
            replace: replaceText,
            replace_all: replaceAll,
            scanned_file_count: matchData.scannedFileCount,
            matched_file_count: matchData.matchedCount,
            affected_file_count: apply ? executedCount : operations.length,
            truncated: matchData.truncated,
            operations,
        };
    } catch (error) {
        return {
            error:
                error instanceof Error
                    ? error.message
                    : "Failed to run fs_bulk_manager.",
        };
    }
}

export async function docDeleteFile(args: Record<string, unknown>) {
    try {
        const inputPath = toStringValue(args.path);
        const filePath = resolveWorkspacePath(inputPath);
        const root = resolveWorkspaceRoot();
        if (filePath === root) {
            return { error: "Refusing to delete the workspace root." };
        }
        const stats = await fs.promises.lstat(filePath);
        const isDirectory = stats.isDirectory();
        const recursive = Boolean(args.recursive);
        if (isDirectory && !recursive) {
            const entries = await fs.promises.readdir(filePath);
            if (entries.length > 0) {
                return { error: "Directory is not empty. Set recursive to true." };
            }
        }

        const { recycle_id, deleted_at, metadata } = await moveToRecycle(filePath);
        return {
            success: true,
            recycle_id,
            original_path: metadata.original_path,
            deleted_at,
        };
    } catch (error) {
        return {
            error: error instanceof Error ? error.message : "Failed to delete file.",
        };
    }
}

export async function docListDir(args: Record<string, unknown>) {
    try {
        const inputPath = toStringValue(args.path || "/");
        const dirPath = resolveDocInspectPath(inputPath);
        const stats = await fs.promises.stat(dirPath);
        if (!stats.isDirectory()) {
            return { error: "Path is not a directory." };
        }

        const recursive = Boolean(args.recursive);
        const includeHidden = Boolean(args.include_hidden);
        const includeTrash = Boolean(args.include_trash);
        const limit = parsePositiveInt(args.limit, DEFAULT_LIST_LIMIT, 1);
        const offset = parsePositiveInt(args.offset, 0, 0);
        const maxDepth =
            args.max_depth === undefined
                ? Number.POSITIVE_INFINITY
                : parsePositiveInt(args.max_depth, 0, 0);
        const entries: Array<{
            path: string;
            name: string;
            type: "file" | "dir";
            size_bytes: number;
            modified_at: string;
        }> = [];

        let seen = 0;
        const queue: Array<{ path: string; depth: number }> = [
            { path: dirPath, depth: 0 },
        ];
        while (queue.length > 0 && entries.length < limit) {
            const current = queue.shift();
            if (!current) {
                break;
            }
            const dirents = await fs.promises.readdir(current.path, {
                withFileTypes: true,
            });
            for (const entry of dirents) {
                if (!includeHidden && entry.name.startsWith(".")) {
                    if (!includeTrash && entry.name === ".recycle_bin") {
                        continue;
                    }
                    if (entry.name !== ".recycle_bin") {
                        continue;
                    }
                }
                if (!includeTrash && entry.name === ".recycle_bin") {
                    continue;
                }
                const fullPath = path.join(current.path, entry.name);
                const stat = await fs.promises.stat(fullPath);
                if (seen >= offset) {
                    entries.push({
                        path: toDocDisplayPath(fullPath),
                        name: entry.name,
                        type: entry.isDirectory() ? "dir" : "file",
                        size_bytes: entry.isDirectory() ? 0 : stat.size,
                        modified_at: stat.mtime.toISOString(),
                    });
                    if (entries.length >= limit) {
                        break;
                    }
                }
                seen += 1;
                if (
                    recursive &&
                    entry.isDirectory() &&
                    current.depth < maxDepth
                ) {
                    queue.push({ path: fullPath, depth: current.depth + 1 });
                }
            }
        }

        return {
            path: toDocDisplayPath(dirPath),
            entries,
            truncated: entries.length >= limit,
            offset,
            limit,
        };
    } catch (error) {
        return {
            error:
                error instanceof Error ? error.message : "Failed to list directory.",
        };
    }
}

export async function docSearch(args: Record<string, unknown>) {
    try {
        const query = toStringValue(args.query);
        if (!query) {
            return { error: "query is required." };
        }
        const inputPath = toStringValue(args.path || "/");
        const searchRoot = resolveDocInspectPath(inputPath);
        const stats = await fs.promises.stat(searchRoot);
        const mode = toStringValue(args.mode || "both");
        if (mode !== "name" && mode !== "content" && mode !== "both") {
            return { error: "mode must be name, content, or both." };
        }
        const caseSensitive = Boolean(args.case_sensitive);
        const includeHidden = Boolean(args.include_hidden);
        const includeTrash = Boolean(args.include_trash);
        const limit = parsePositiveInt(args.limit, DEFAULT_SEARCH_LIMIT, 1);
        const offset = parsePositiveInt(args.offset, 0, 0);
        const maxBytes = parsePositiveInt(
            args.max_file_bytes,
            DEFAULT_MAX_SEARCH_BYTES,
            1
        );
        const maxDepth =
            args.max_depth === undefined
                ? Number.POSITIVE_INFINITY
                : parsePositiveInt(args.max_depth, 0, 0);
        const useRegex = Boolean(args.use_regex);
        const extensionPolicy = getSearchExtensionPolicy(args.extensions);
        const excludeDirs = parseExcludeDirs(args.exclude_dirs);

        const matches: Array<{
            path: string;
            match: "name" | "content";
            snippet?: string;
            line?: number;
            column?: number;
        }> = [];
        let matchCount = 0;
        let truncated = false;

        let searchRegex: RegExp | null = null;
        if (useRegex) {
            const rawFlags = toStringValue(args.flags);
            let flags = rawFlags;
            if (!caseSensitive && !flags.includes("i")) {
                flags += "i";
            }
            try {
                searchRegex = new RegExp(query, flags);
            } catch {
                return { error: "Invalid regex pattern or flags." };
            }
        }

        const needle = caseSensitive ? query : query.toLowerCase();

        const registerMatch = (entry: {
            path: string;
            match: "name" | "content";
            snippet?: string;
            line?: number;
            column?: number;
        }) => {
            matchCount += 1;
            if (matchCount <= offset) {
                return;
            }
            matches.push(entry);
            if (matches.length >= limit) {
                truncated = true;
            }
        };

        const processFile = async (filePath: string) => {
            if (matches.length >= limit) {
                return;
            }
            const basename = path.basename(filePath);
            const nameHaystack = caseSensitive ? basename : basename.toLowerCase();
            if (mode === "name" || mode === "both") {
                const nameMatched = searchRegex
                    ? searchRegex.test(basename)
                    : nameHaystack.includes(needle);
                if (searchRegex) {
                    searchRegex.lastIndex = 0;
                }
                if (nameMatched) {
                    registerMatch({
                        path: toDocDisplayPath(filePath),
                        match: "name",
                    });
                }
            }
            if (matches.length >= limit) {
                return;
            }
            if (mode !== "content" && mode !== "both") {
                return;
            }
            const ext = path.extname(filePath).toLowerCase();
            if (!extensionPolicy.allowAny && !extensionPolicy.extensions.has(ext)) {
                return;
            }
            const stat = await fs.promises.stat(filePath);
            if (stat.size > maxBytes) {
                return;
            }
            const content = await fs.promises.readFile(filePath, "utf8");
            let index = -1;
            let matchText = "";
            if (searchRegex) {
                const result = searchRegex.exec(content);
                if (result && typeof result.index === "number") {
                    index = result.index;
                    matchText = result[0] ?? "";
                }
                searchRegex.lastIndex = 0;
            } else {
                const haystack = caseSensitive ? content : content.toLowerCase();
                index = haystack.indexOf(needle);
                matchText = query;
            }
            if (index !== -1) {
                const snippetStart = Math.max(0, index - 60);
                const snippetEnd = Math.min(
                    content.length,
                    index + Math.max(matchText.length, 1) + 60
                );
                const prefix = content.slice(0, index);
                const lines = prefix.split(/\r\n|\r|\n/);
                const line = lines.length;
                const column = (lines[lines.length - 1] ?? "").length + 1;
                registerMatch({
                    path: toDocDisplayPath(filePath),
                    match: "content",
                    snippet: content.slice(snippetStart, snippetEnd).replace(/\s+/g, " "),
                    line,
                    column,
                });
            }
        };

        if (stats.isFile()) {
            await processFile(searchRoot);
        } else {
            const queue: Array<{ path: string; depth: number }> = [
                { path: searchRoot, depth: 0 },
            ];
            while (queue.length > 0 && matches.length < limit) {
                const current = queue.shift();
                if (!current) {
                    break;
                }
                const dirents = await fs.promises.readdir(current.path, {
                    withFileTypes: true,
                });
                for (const entry of dirents) {
                    if (!includeHidden && entry.name.startsWith(".")) {
                        if (!includeTrash && entry.name === ".recycle_bin") {
                            continue;
                        }
                        if (entry.name !== ".recycle_bin") {
                            continue;
                        }
                    }
                    if (!includeTrash && entry.name === ".recycle_bin") {
                        continue;
                    }
                    const fullPath = path.join(current.path, entry.name);
                    const rootRelativePath = path
                        .relative(searchRoot, fullPath)
                        .split(path.sep)
                        .join("/");
                    if (
                        entry.isDirectory() &&
                        (excludeDirs.has(entry.name) ||
                            excludeDirs.has(rootRelativePath))
                    ) {
                        continue;
                    }
                    if (entry.isDirectory()) {
                        if (current.depth < maxDepth) {
                            queue.push({ path: fullPath, depth: current.depth + 1 });
                        }
                    } else {
                        await processFile(fullPath);
                        if (matches.length >= limit) {
                            break;
                        }
                    }
                }
            }
        }

        return {
            query,
            matches,
            truncated,
            offset,
            limit,
        };
    } catch (error) {
        return {
            error: error instanceof Error ? error.message : "Failed to search files.",
        };
    }
}

export async function docCreateDir(args: Record<string, unknown>) {
    try {
        const inputPath = toStringValue(args.path);
        const dirPath = resolveWorkspacePath(inputPath);
        const recursive = args.recursive !== false;
        await fs.promises.mkdir(dirPath, { recursive });
        return { success: true, path: toWorkspaceRelative(dirPath) };
    } catch (error) {
        return {
            error:
                error instanceof Error ? error.message : "Failed to create directory.",
        };
    }
}

export async function docStat(args: Record<string, unknown>) {
    try {
        const inputPath = toStringValue(args.path);
        const filePath = resolveDocInspectPath(inputPath);
        const stats = await fs.promises.lstat(filePath);
        const isSymlink = stats.isSymbolicLink();
        let type: "file" | "dir" | "symlink" | "other" = "other";
        if (stats.isDirectory()) {
            type = "dir";
        } else if (stats.isFile()) {
            type = "file";
        } else if (isSymlink) {
            type = "symlink";
        }
        let linkTarget: string | undefined;
        if (isSymlink) {
            try {
                linkTarget = await fs.promises.readlink(filePath);
            } catch {
                linkTarget = undefined;
            }
        }
        return {
            path: toDocDisplayPath(filePath),
            type,
            size_bytes: stats.size,
            modified_at: stats.mtime.toISOString(),
            created_at: stats.birthtime.toISOString(),
            is_symlink: isSymlink,
            link_target: linkTarget,
        };
    } catch (error) {
        return {
            error: error instanceof Error ? error.message : "Failed to stat path.",
        };
    }
}

export async function moveWorkspacePath(
    sourcePath: string,
    destinationPath: string,
    overwrite: boolean
) {
    const root = resolveWorkspaceRoot();
    if (sourcePath === root) {
        throw new Error("Refusing to move the workspace root.");
    }
    if (destinationPath === root) {
        throw new Error("Destination cannot be the workspace root.");
    }
    if (sourcePath === destinationPath) {
        return;
    }
    await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
    if (await pathExists(destinationPath)) {
        if (!overwrite) {
            throw new Error("Destination already exists. Set overwrite to true.");
        }
        await moveToRecycle(destinationPath);
    }
    await fs.promises.rename(sourcePath, destinationPath);
}

export async function docMove(args: Record<string, unknown>) {
    try {
        const inputPath = toStringValue(args.path);
        const destinationInput = toStringValue(args.destination_path);
        if (!destinationInput) {
            return { error: "destination_path is required." };
        }
        const sourcePath = resolveWorkspacePath(inputPath);
        const destinationPath = resolveWorkspacePath(destinationInput);
        const overwrite = Boolean(args.overwrite);
        await moveWorkspacePath(sourcePath, destinationPath, overwrite);
        return {
            success: true,
            from: toWorkspaceRelative(sourcePath),
            to: toWorkspaceRelative(destinationPath),
        };
    } catch (error) {
        return {
            error: error instanceof Error ? error.message : "Failed to move path.",
        };
    }
}

export async function docCopy(args: Record<string, unknown>) {
    try {
        const inputPath = toStringValue(args.path);
        const destinationInput = toStringValue(args.destination_path);
        if (!destinationInput) {
            return { error: "destination_path is required." };
        }
        const sourcePath = resolveWorkspacePath(inputPath);
        const destinationPath = resolveWorkspacePath(destinationInput);
        const overwrite = Boolean(args.overwrite);
        const recursive = args.recursive !== false;
        const root = resolveWorkspaceRoot();
        if (sourcePath === root) {
            return { error: "Refusing to copy the workspace root." };
        }
        if (destinationPath === root) {
            return { error: "Destination cannot be the workspace root." };
        }
        const stats = await fs.promises.lstat(sourcePath);
        if (stats.isDirectory() && !recursive) {
            return { error: "Directory copy requires recursive=true." };
        }
        if (await pathExists(destinationPath)) {
            if (!overwrite) {
                return { error: "Destination already exists. Set overwrite to true." };
            }
            await moveToRecycle(destinationPath);
        }
        await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
        if (stats.isDirectory()) {
            await fs.promises.cp(sourcePath, destinationPath, { recursive: true });
        } else {
            await fs.promises.copyFile(sourcePath, destinationPath);
        }
        return {
            success: true,
            from: toWorkspaceRelative(sourcePath),
            to: toWorkspaceRelative(destinationPath),
        };
    } catch (error) {
        return {
            error: error instanceof Error ? error.message : "Failed to copy path.",
        };
    }
}

export async function docRename(args: Record<string, unknown>) {
    try {
        const inputPath = toStringValue(args.path);
        const newName = toStringValue(args.new_name);
        if (!newName) {
            return { error: "new_name is required." };
        }
        if (newName.includes("/") || newName.includes("\\")) {
            return { error: "new_name must not include path separators." };
        }
        const sourcePath = resolveWorkspacePath(inputPath);
        const destinationPath = path.join(path.dirname(sourcePath), newName);
        const overwrite = Boolean(args.overwrite);
        await moveWorkspacePath(sourcePath, destinationPath, overwrite);
        return {
            success: true,
            from: toWorkspaceRelative(sourcePath),
            to: toWorkspaceRelative(destinationPath),
        };
    } catch (error) {
        return {
            error: error instanceof Error ? error.message : "Failed to rename path.",
        };
    }
}
