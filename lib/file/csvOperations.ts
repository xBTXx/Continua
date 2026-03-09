import fs from "fs";
import path from "path";
import {
    toStringValue,
    normalizeInputPath,
    assertCsvFilePath,
    resolveWorkspacePath,
    normalizeDelimiter,
    toWorkspaceRelative,
    parsePositiveInt
} from "./utils";
import { normalizeCsvRows, readCsvData, writeCsvData, matchRow, rowsToObjects } from "./csv";
import { ensureWorkspaceRoot } from "./recycle";

export async function csvCreateFile(args: Record<string, unknown>) {
    try {
        const inputPath = toStringValue(args.path);
        const relative = normalizeInputPath(inputPath);
        assertCsvFilePath(relative);
        const filePath = resolveWorkspacePath(inputPath);
        const headers = Array.isArray(args.headers)
            ? args.headers.map((entry) => toStringValue(entry))
            : [];
        if (headers.length === 0) {
            return { error: "headers are required." };
        }
        const rows = normalizeCsvRows(headers, args.rows ?? []);
        const overwrite = Boolean(args.overwrite);
        const delimiter = normalizeDelimiter(args.delimiter);
        await ensureWorkspaceRoot();
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        try {
            const existing = await fs.promises.stat(filePath);
            if (existing.isFile() && !overwrite) {
                return { error: "File already exists. Set overwrite to true." };
            }
            if (existing.isDirectory()) {
                return { error: "A directory exists at that path." };
            }
        } catch {
            // file does not exist
        }
        await writeCsvData(filePath, { headers, rows }, delimiter);
        return {
            success: true,
            path: toWorkspaceRelative(filePath),
            headers,
            rows_written: rows.length,
        };
    } catch (error) {
        return {
            error: error instanceof Error ? error.message : "Failed to create CSV.",
        };
    }
}

export async function csvRead(args: Record<string, unknown>) {
    try {
        const inputPath = toStringValue(args.path);
        const relative = normalizeInputPath(inputPath);
        assertCsvFilePath(relative);
        const filePath = resolveWorkspacePath(inputPath);
        const delimiter = normalizeDelimiter(args.delimiter);
        const { headers, rows } = await readCsvData(filePath, delimiter);
        const offset = parsePositiveInt(args.offset, 0, 0);
        const limit = parsePositiveInt(args.limit, rows.length, 0);
        const asObjects = args.as_objects !== false;
        const sliced = rows.slice(offset, offset + limit);
        return {
            path: toWorkspaceRelative(filePath),
            headers,
            rows: asObjects ? rowsToObjects(headers, sliced) : sliced,
            total_rows: rows.length,
            offset,
            limit,
        };
    } catch (error) {
        return {
            error: error instanceof Error ? error.message : "Failed to read CSV.",
        };
    }
}

export async function csvAppendRows(args: Record<string, unknown>) {
    try {
        const inputPath = toStringValue(args.path);
        const relative = normalizeInputPath(inputPath);
        assertCsvFilePath(relative);
        const filePath = resolveWorkspacePath(inputPath);
        const delimiter = normalizeDelimiter(args.delimiter);
        const data = await readCsvData(filePath, delimiter);
        const newRows = normalizeCsvRows(data.headers, args.rows ?? []);
        data.rows.push(...newRows);
        await writeCsvData(filePath, data, delimiter);
        return {
            success: true,
            path: toWorkspaceRelative(filePath),
            rows_appended: newRows.length,
            total_rows: data.rows.length,
        };
    } catch (error) {
        return {
            error: error instanceof Error ? error.message : "Failed to append rows.",
        };
    }
}

export async function csvFilterRows(args: Record<string, unknown>) {
    try {
        const inputPath = toStringValue(args.path);
        const relative = normalizeInputPath(inputPath);
        assertCsvFilePath(relative);
        const filePath = resolveWorkspacePath(inputPath);
        const delimiter = normalizeDelimiter(args.delimiter);
        const data = await readCsvData(filePath, delimiter);
        const where =
            args.where && typeof args.where === "object"
                ? (args.where as Record<string, unknown>)
                : undefined;
        const contains =
            args.contains && typeof args.contains === "object"
                ? (args.contains as Record<string, unknown>)
                : undefined;
        if (!where && !contains) {
            return { error: "where or contains filters are required." };
        }
        const caseSensitive = Boolean(args.case_sensitive);
        const matched = data.rows.filter((row) =>
            matchRow(data.headers, row, where, contains, caseSensitive)
        );
        const offset = parsePositiveInt(args.offset, 0, 0);
        const limit = parsePositiveInt(args.limit, matched.length, 0);
        const asObjects = args.as_objects !== false;
        const sliced = matched.slice(offset, offset + limit);
        return {
            path: toWorkspaceRelative(filePath),
            headers: data.headers,
            rows: asObjects ? rowsToObjects(data.headers, sliced) : sliced,
            total_matched: matched.length,
            offset,
            limit,
        };
    } catch (error) {
        return {
            error: error instanceof Error ? error.message : "Failed to filter rows.",
        };
    }
}

export function normalizeRowIndices(value: unknown) {
    if (typeof value === "number") {
        return [value];
    }
    if (Array.isArray(value)) {
        return value.map((entry) => Number(entry));
    }
    return [];
}

export async function csvUpdateRows(args: Record<string, unknown>) {
    try {
        const inputPath = toStringValue(args.path);
        const relative = normalizeInputPath(inputPath);
        assertCsvFilePath(relative);
        const filePath = resolveWorkspacePath(inputPath);
        const delimiter = normalizeDelimiter(args.delimiter);
        const data = await readCsvData(filePath, delimiter);
        const set =
            args.set && typeof args.set === "object"
                ? (args.set as Record<string, unknown>)
                : null;
        if (!set) {
            return { error: "set is required." };
        }

        const rowIndices = normalizeRowIndices(args.row_index ?? args.row_indices)
            .map((value) => Math.floor(value))
            .filter((value) => Number.isFinite(value) && value >= 1);
        const where =
            args.where && typeof args.where === "object"
                ? (args.where as Record<string, unknown>)
                : undefined;
        const contains =
            args.contains && typeof args.contains === "object"
                ? (args.contains as Record<string, unknown>)
                : undefined;
        const caseSensitive = Boolean(args.case_sensitive);

        if (rowIndices.length === 0 && !where && !contains) {
            return { error: "row_index or filters are required." };
        }

        const indexSet = new Set(rowIndices);
        const updatedRows: string[][] = [];
        let updatedCount = 0;

        data.rows = data.rows.map((row, index) => {
            const rowIndex = index + 1;
            const shouldUpdate =
                (indexSet.size > 0 && indexSet.has(rowIndex)) ||
                (indexSet.size === 0 &&
                    matchRow(data.headers, row, where, contains, caseSensitive));
            if (!shouldUpdate) {
                return row;
            }
            updatedCount += 1;
            const updated = [...row];
            for (const [key, value] of Object.entries(set)) {
                const headerIndex = data.headers.indexOf(key);
                if (headerIndex === -1) {
                    throw new Error(`Unknown column: ${key}`);
                }
                updated[headerIndex] = toStringValue(value);
            }
            updatedRows.push(updated);
            return updated;
        });

        await writeCsvData(filePath, data, delimiter);
        const returnLimit = parsePositiveInt(args.return_limit, 5, 0);
        return {
            success: true,
            path: toWorkspaceRelative(filePath),
            updated_count: updatedCount,
            updated_rows:
                returnLimit > 0
                    ? rowsToObjects(data.headers, updatedRows.slice(0, returnLimit))
                    : [],
        };
    } catch (error) {
        return {
            error: error instanceof Error ? error.message : "Failed to update rows.",
        };
    }
}

export async function csvDeleteRows(args: Record<string, unknown>) {
    try {
        const inputPath = toStringValue(args.path);
        const relative = normalizeInputPath(inputPath);
        assertCsvFilePath(relative);
        const filePath = resolveWorkspacePath(inputPath);
        const delimiter = normalizeDelimiter(args.delimiter);
        const data = await readCsvData(filePath, delimiter);
        const rowIndices = normalizeRowIndices(args.row_index ?? args.row_indices)
            .map((value) => Math.floor(value))
            .filter((value) => Number.isFinite(value) && value >= 1);
        const where =
            args.where && typeof args.where === "object"
                ? (args.where as Record<string, unknown>)
                : undefined;
        const contains =
            args.contains && typeof args.contains === "object"
                ? (args.contains as Record<string, unknown>)
                : undefined;
        const caseSensitive = Boolean(args.case_sensitive);

        if (rowIndices.length === 0 && !where && !contains) {
            return { error: "row_index or filters are required." };
        }

        const indexSet = new Set(rowIndices);
        const keptRows: string[][] = [];
        let deletedCount = 0;
        data.rows.forEach((row, index) => {
            const rowIndex = index + 1;
            const shouldDelete =
                (indexSet.size > 0 && indexSet.has(rowIndex)) ||
                (indexSet.size === 0 &&
                    matchRow(data.headers, row, where, contains, caseSensitive));
            if (shouldDelete) {
                deletedCount += 1;
            } else {
                keptRows.push(row);
            }
        });
        data.rows = keptRows;
        await writeCsvData(filePath, data, delimiter);
        return {
            success: true,
            path: toWorkspaceRelative(filePath),
            deleted_count: deletedCount,
            remaining_rows: data.rows.length,
        };
    } catch (error) {
        return {
            error: error instanceof Error ? error.message : "Failed to delete rows.",
        };
    }
}

export async function csvColumnTotals(args: Record<string, unknown>) {
    try {
        const inputPath = toStringValue(args.path);
        const relative = normalizeInputPath(inputPath);
        assertCsvFilePath(relative);
        const filePath = resolveWorkspacePath(inputPath);
        const delimiter = normalizeDelimiter(args.delimiter);
        const data = await readCsvData(filePath, delimiter);
        let columns = Array.isArray(args.columns)
            ? args.columns.map((entry) => toStringValue(entry))
            : data.headers;
        if (columns.length === 0) {
            columns = data.headers;
        }
        const totals: Record<string, number> = {};
        const counts: Record<string, number> = {};
        columns.forEach((column) => {
            const index = data.headers.indexOf(column);
            if (index === -1) {
                throw new Error(`Unknown column: ${column}`);
            }
            let total = 0;
            let count = 0;
            data.rows.forEach((row) => {
                const value = row[index];
                const num = Number(value);
                if (Number.isFinite(num)) {
                    total += num;
                    count += 1;
                }
            });
            totals[column] = total;
            counts[column] = count;
        });
        return {
            path: toWorkspaceRelative(filePath),
            totals,
            numeric_counts: counts,
        };
    } catch (error) {
        return {
            error:
                error instanceof Error ? error.message : "Failed to calculate totals.",
        };
    }
}
