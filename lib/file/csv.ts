import fs from "fs";
import { toStringValue } from "./utils";
import { CsvData } from "./types";

export function escapeCsvField(value: string, delimiter: string) {
    const needsQuote =
        value.includes(delimiter) ||
        value.includes('"') ||
        value.includes("\n") ||
        value.includes("\r") ||
        /^\s|\s$/.test(value);
    if (!needsQuote) {
        return value;
    }
    return `"${value.replace(/"/g, '""')}"`;
}

export function parseCsv(text: string, delimiter: string) {
    if (text.trim() === "") {
        return [];
    }
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let inQuotes = false;

    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        if (inQuotes) {
            if (char === '"') {
                const next = text[i + 1];
                if (next === '"') {
                    field += '"';
                    i += 1;
                } else {
                    inQuotes = false;
                }
            } else {
                field += char;
            }
            continue;
        }

        if (char === '"') {
            inQuotes = true;
            continue;
        }
        if (char === delimiter) {
            row.push(field);
            field = "";
            continue;
        }
        if (char === "\n") {
            row.push(field);
            rows.push(row);
            row = [];
            field = "";
            continue;
        }
        if (char === "\r") {
            if (text[i + 1] === "\n") {
                i += 1;
            }
            row.push(field);
            rows.push(row);
            row = [];
            field = "";
            continue;
        }

        field += char;
    }

    row.push(field);
    rows.push(row);

    if (rows.length > 1) {
        const last = rows[rows.length - 1];
        if (last.length === 1 && last[0] === "") {
            rows.pop();
        }
    }

    return rows;
}

export function stringifyCsv(rows: string[][], delimiter: string) {
    return (
        rows
            .map((row) =>
                row.map((value) => escapeCsvField(value, delimiter)).join(delimiter)
            )
            .join("\n") + "\n"
    );
}

export function normalizeCsvRows(headers: string[], rows: unknown) {
    if (rows === undefined || rows === null) {
        return [];
    }
    if (!Array.isArray(rows)) {
        throw new Error("rows must be an array.");
    }
    return rows.map((row) => {
        if (Array.isArray(row)) {
            return headers.map((_, index) => toStringValue(row[index]));
        }
        if (row && typeof row === "object") {
            const record = row as Record<string, unknown>;
            return headers.map((header) => toStringValue(record[header]));
        }
        throw new Error("CSV rows must be arrays or objects.");
    });
}

export function rowsToObjects(headers: string[], rows: string[][]) {
    return rows.map((row) => {
        const record: Record<string, string> = {};
        headers.forEach((header, index) => {
            record[header] = row[index] ?? "";
        });
        return record;
    });
}

export function matchRow(
    headers: string[],
    row: string[],
    where?: Record<string, unknown>,
    contains?: Record<string, unknown>,
    caseSensitive?: boolean
) {
    if (where) {
        for (const [key, value] of Object.entries(where)) {
            const index = headers.indexOf(key);
            if (index === -1) {
                throw new Error(`Unknown column: ${key}`);
            }
            const cell = row[index] ?? "";
            const target = toStringValue(value);
            if (caseSensitive) {
                if (cell !== target) {
                    return false;
                }
            } else if (cell.toLowerCase() !== target.toLowerCase()) {
                return false;
            }
        }
    }
    if (contains) {
        for (const [key, value] of Object.entries(contains)) {
            const index = headers.indexOf(key);
            if (index === -1) {
                throw new Error(`Unknown column: ${key}`);
            }
            const cell = row[index] ?? "";
            const target = toStringValue(value);
            if (caseSensitive) {
                if (!cell.includes(target)) {
                    return false;
                }
            } else if (!cell.toLowerCase().includes(target.toLowerCase())) {
                return false;
            }
        }
    }
    return true;
}

export async function readCsvData(filePath: string, delimiter: string): Promise<CsvData> {
    const raw = await fs.promises.readFile(filePath, "utf8");
    const rows = parseCsv(raw, delimiter);
    if (rows.length === 0) {
        return { headers: [], rows: [] };
    }
    const headers = rows.shift() ?? [];
    if (headers[0]?.startsWith("\uFEFF")) {
        headers[0] = headers[0].replace(/^\uFEFF/, "");
    }
    return { headers, rows };
}

export async function writeCsvData(
    filePath: string,
    data: CsvData,
    delimiter: string
) {
    const output = stringifyCsv([data.headers, ...data.rows], delimiter);
    await fs.promises.writeFile(filePath, output, "utf8");
}
