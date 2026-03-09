export type UnifiedDiffLineKind = "context" | "add" | "remove";

export type UnifiedDiffLine = {
    kind: UnifiedDiffLineKind;
    text: string;
};

export type UnifiedDiffHunk = {
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    lines: UnifiedDiffLine[];
};

export type UnifiedDiffFile = {
    oldPathRaw: string;
    newPathRaw: string;
    hunks: UnifiedDiffHunk[];
};

export type ApplyUnifiedHunksInput = {
    originalContent: string;
    hunks: UnifiedDiffHunk[];
    fileLabel?: string;
};

export type ApplyUnifiedHunksResult = {
    content: string;
    hunksApplied: number;
};

type LineLayout = {
    lines: string[];
    trailingNewline: boolean;
    newlineStyle: "lf" | "crlf";
};

function parseHunkHeader(line: string) {
    const match = line.match(
        /^@@\s*-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s*@@/
    );
    if (!match) {
        throw new Error(`Invalid hunk header: ${line}`);
    }
    const oldStart = Number(match[1]);
    const oldCount = match[2] === undefined ? 1 : Number(match[2]);
    const newStart = Number(match[3]);
    const newCount = match[4] === undefined ? 1 : Number(match[4]);
    if (
        !Number.isInteger(oldStart) ||
        !Number.isInteger(oldCount) ||
        !Number.isInteger(newStart) ||
        !Number.isInteger(newCount)
    ) {
        throw new Error(`Invalid hunk header numbers: ${line}`);
    }
    return { oldStart, oldCount, newStart, newCount };
}

function validateHunkLineCounts(
    hunk: Omit<UnifiedDiffHunk, "lines">,
    lines: UnifiedDiffLine[]
) {
    const oldLines = lines.filter((line) => line.kind !== "add").length;
    const newLines = lines.filter((line) => line.kind !== "remove").length;
    if (oldLines !== hunk.oldCount) {
        throw new Error(
            `Hunk old line count mismatch (expected ${hunk.oldCount}, got ${oldLines}). Fix @@ header: old count must equal context+removed lines.`
        );
    }
    if (newLines !== hunk.newCount) {
        throw new Error(
            `Hunk new line count mismatch (expected ${hunk.newCount}, got ${newLines}). Fix @@ header: new count must equal context+added lines.`
        );
    }
}

function parseHunkLine(line: string): UnifiedDiffLine {
    const prefix = line[0];
    if (prefix === " ") {
        return { kind: "context", text: line.slice(1) };
    }
    if (prefix === "+") {
        return { kind: "add", text: line.slice(1) };
    }
    if (prefix === "-") {
        return { kind: "remove", text: line.slice(1) };
    }
    throw new Error(`Invalid hunk line prefix: ${line}`);
}

function isMetadataLine(line: string) {
    return (
        line.startsWith("diff --git ") ||
        line.startsWith("index ") ||
        line.startsWith("new file mode ") ||
        line.startsWith("deleted file mode ") ||
        line.startsWith("old mode ") ||
        line.startsWith("new mode ") ||
        line.startsWith("similarity index ") ||
        line.startsWith("rename from ") ||
        line.startsWith("rename to ") ||
        line.startsWith("Binary files ") ||
        line.startsWith("GIT binary patch") ||
        line.startsWith("Index: ")
    );
}

function parsePathToken(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed) {
        throw new Error("Patch path is empty.");
    }
    if (trimmed.startsWith("\"")) {
        let escaped = false;
        let token = "";
        for (let index = 1; index < trimmed.length; index += 1) {
            const char = trimmed[index];
            if (escaped) {
                token += char;
                escaped = false;
                continue;
            }
            if (char === "\\") {
                escaped = true;
                continue;
            }
            if (char === "\"") {
                return token;
            }
            token += char;
        }
        throw new Error("Unterminated quoted patch path.");
    }
    const tabIndex = trimmed.indexOf("\t");
    if (tabIndex !== -1) {
        return trimmed.slice(0, tabIndex);
    }
    const tokenMatch = trimmed.match(/^\S+/);
    if (!tokenMatch) {
        throw new Error("Patch path is empty.");
    }
    return tokenMatch[0];
}

function stripPathSegments(value: string, count: number) {
    if (count <= 0) {
        return value;
    }
    const segments = value.split("/").filter(Boolean);
    if (segments.length <= count) {
        throw new Error(
            `strip=${count} removes the whole patch path "${value}".`
        );
    }
    return segments.slice(count).join("/");
}

function splitLines(content: string): LineLayout {
    const newlineStyle = content.includes("\r\n") ? "crlf" : "lf";
    const normalized = content.replace(/\r\n/g, "\n");
    const trailingNewline = normalized.endsWith("\n");
    if (normalized.length === 0) {
        return { lines: [], trailingNewline: false, newlineStyle };
    }
    const lines = normalized.split("\n");
    if (trailingNewline) {
        lines.pop();
    }
    return { lines, trailingNewline, newlineStyle };
}

function joinLines(layout: LineLayout) {
    let normalized = layout.lines.join("\n");
    if (layout.trailingNewline) {
        normalized += "\n";
    }
    if (layout.newlineStyle === "crlf") {
        return normalized.replace(/\n/g, "\r\n");
    }
    return normalized;
}

function formatLinePreview(value: string | undefined) {
    if (value === undefined) {
        return "<EOF>";
    }
    return JSON.stringify(value);
}

export function parseUnifiedDiffPatch(patch: string): UnifiedDiffFile[] {
    const normalized = patch.replace(/\r\n/g, "\n");
    const lines = normalized.split("\n");
    const files: UnifiedDiffFile[] = [];

    let index = 0;
    while (index < lines.length) {
        const line = lines[index];
        if (!line.startsWith("--- ")) {
            index += 1;
            continue;
        }

        const oldPathRaw = line.slice(4);
        index += 1;
        if (index >= lines.length || !lines[index].startsWith("+++ ")) {
            throw new Error("Malformed patch: expected +++ line after --- line.");
        }
        const newPathRaw = lines[index].slice(4);
        index += 1;

        const hunks: UnifiedDiffHunk[] = [];
        while (index < lines.length) {
            const current = lines[index];
            if (current.startsWith("@@ ")) {
                const header = parseHunkHeader(current);
                index += 1;
                const hunkLines: UnifiedDiffLine[] = [];
                let consumedOld = 0;
                let consumedNew = 0;

                while (
                    index < lines.length &&
                    (consumedOld < header.oldCount ||
                        consumedNew < header.newCount)
                ) {
                    const bodyLine = lines[index];
                    if (bodyLine.startsWith("\\ No newline at end of file")) {
                        index += 1;
                        continue;
                    }
                    const parsedLine = parseHunkLine(bodyLine);
                    hunkLines.push(parsedLine);
                    if (parsedLine.kind === "context") {
                        consumedOld += 1;
                        consumedNew += 1;
                    } else if (parsedLine.kind === "remove") {
                        consumedOld += 1;
                    } else {
                        consumedNew += 1;
                    }
                    index += 1;
                }
                while (
                    index < lines.length &&
                    lines[index].startsWith("\\ No newline at end of file")
                ) {
                    index += 1;
                }

                validateHunkLineCounts(header, hunkLines);
                hunks.push({
                    oldStart: header.oldStart,
                    oldCount: header.oldCount,
                    newStart: header.newStart,
                    newCount: header.newCount,
                    lines: hunkLines,
                });
                continue;
            }

            if (current.startsWith("--- ")) {
                break;
            }
            if (current === "" || isMetadataLine(current)) {
                index += 1;
                continue;
            }

            throw new Error(`Unexpected patch line: ${current}`);
        }

        files.push({ oldPathRaw, newPathRaw, hunks });
    }

    if (files.length === 0) {
        throw new Error("No unified diff file headers were found.");
    }
    return files;
}

export function normalizeUnifiedDiffPath(
    rawPath: string,
    strip: number | null
) {
    const token = parsePathToken(rawPath);
    if (token === "/dev/null") {
        return token;
    }
    const normalizedToken = token.replace(/\\/g, "/");
    const autoStrip =
        normalizedToken.startsWith("a/") || normalizedToken.startsWith("b/")
            ? 1
            : 0;
    const stripCount = strip === null ? autoStrip : strip;
    const stripped = stripPathSegments(normalizedToken, stripCount).replace(
        /^\/+/,
        ""
    );
    if (!stripped) {
        throw new Error("Patch path resolves to an empty value.");
    }
    return stripped;
}

export function applyUnifiedHunksToText(
    input: ApplyUnifiedHunksInput
): ApplyUnifiedHunksResult {
    const source = splitLines(input.originalContent);
    const output: string[] = [];
    let sourceIndex = 0;

    input.hunks.forEach((hunk, hunkIndex) => {
        const hunkStartIndex = hunk.oldStart <= 0 ? 0 : hunk.oldStart - 1;
        if (hunkStartIndex < sourceIndex) {
            throw new Error(
                `${input.fileLabel ?? "patch"}: hunk ${hunkIndex + 1
                } overlaps with a previous hunk.`
            );
        }
        if (hunkStartIndex > source.lines.length) {
            throw new Error(
                `${input.fileLabel ?? "patch"}: hunk ${hunkIndex + 1
                } starts beyond end of file.`
            );
        }

        output.push(...source.lines.slice(sourceIndex, hunkStartIndex));
        sourceIndex = hunkStartIndex;

        hunk.lines.forEach((line, lineIndex) => {
            if (line.kind === "add") {
                output.push(line.text);
                return;
            }

            const actual = source.lines[sourceIndex];
            if (actual !== line.text) {
                throw new Error(
                    `${input.fileLabel ?? "patch"}: hunk ${hunkIndex + 1
                    } line ${lineIndex + 1} does not match source (expected ${formatLinePreview(
                        line.text
                    )}, got ${formatLinePreview(actual)}).`
                );
            }

            if (line.kind === "context") {
                output.push(actual);
            }
            sourceIndex += 1;
        });
    });

    output.push(...source.lines.slice(sourceIndex));
    const content = joinLines({
        lines: output,
        trailingNewline: source.trailingNewline,
        newlineStyle: source.newlineStyle,
    });
    return { content, hunksApplied: input.hunks.length };
}
