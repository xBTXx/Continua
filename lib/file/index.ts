import fs from "fs";
import { FileToolStatus } from "./types";
import {
    docToolsEnabled,
    csvToolsEnabled,
    resolveWorkspaceRoot,
    getRecycleDays,
    getDocExtensionPolicy,
    getSearchExtensionPolicy,
    formatExtensionList
} from "./utils";
import * as docOps from "./docOperations";
import * as csvOps from "./csvOperations";
import { docListTrash, docRestore } from "./recycle";

export * from "./types";
export * from "./constants";
export * from "./utils";
export * from "./csv";
export * from "./recycle";
export * from "./docOperations";
export * from "./csvOperations";
export * from "./definitions";

export function getDocToolStatus(): FileToolStatus[] {
    if (!docToolsEnabled()) {
        return [
            {
                id: "doc-tools",
                label: "Docs workspace",
                status: "error",
                details: ["Disabled (DOC_TOOLS_ENABLED=false)."],
            },
        ];
    }
    const root = resolveWorkspaceRoot();
    const exists = fs.existsSync(root);
    const extensionPolicy = getDocExtensionPolicy();
    const searchPolicy = getSearchExtensionPolicy(undefined);
    return [
        {
            id: "doc-tools",
            label: "Docs workspace",
            status: "ok",
            details: [
                `Root: ${root}`,
                exists ? "Ready for use." : "Root missing (created on first use).",
                "Read/list/search/stat can also inspect project and absolute system paths.",
                extensionPolicy.allowAny
                    ? "Extensions: all"
                    : `Extensions: ${formatExtensionList(extensionPolicy.extensions) || "none"}`,
                searchPolicy.allowAny
                    ? "Search content: all"
                    : `Search content: ${formatExtensionList(searchPolicy.extensions) || "none"
                    }`,
                `Recycle retention: ${getRecycleDays()} days.`,
            ],
        },
    ];
}

export function getCsvToolStatus(): FileToolStatus[] {
    if (!csvToolsEnabled()) {
        return [
            {
                id: "csv-tools",
                label: "CSV workspace",
                status: "error",
                details: ["Disabled (CSV_TOOLS_ENABLED=false)."],
            },
        ];
    }
    const root = resolveWorkspaceRoot();
    const exists = fs.existsSync(root);
    return [
        {
            id: "csv-tools",
            label: "CSV workspace",
            status: "ok",
            details: [
                `Root: ${root}`,
                exists ? "Ready for use." : "Root missing (created on first use).",
                `Recycle retention: ${getRecycleDays()} days.`,
            ],
        },
    ];
}

export async function runDocTool(name: string, args: Record<string, unknown>) {
    if (!docToolsEnabled()) {
        throw new Error("Doc tools are disabled.");
    }
    switch (name) {
        case "doc_create_file":
            return docOps.docCreateFile(args);
        case "doc_read_file":
            return docOps.docReadFile(args);
        case "doc_update_file":
            return docOps.docUpdateFile(args);
        case "doc_apply_patch":
            return docOps.docApplyPatch(args);
        case "fs_bulk_manager":
            return docOps.fsBulkManager(args);
        case "doc_delete_file":
            return docOps.docDeleteFile(args);
        case "doc_list_dir":
            return docOps.docListDir(args);
        case "doc_search":
            return docOps.docSearch(args);
        case "doc_create_dir":
            return docOps.docCreateDir(args);
        case "doc_stat":
            return docOps.docStat(args);
        case "doc_move":
            return docOps.docMove(args);
        case "doc_copy":
            return docOps.docCopy(args);
        case "doc_rename":
            return docOps.docRename(args);
        case "doc_list_trash":
            return docListTrash(args);
        case "doc_restore":
            return docRestore(args);
        default:
            throw new Error(`Unknown doc tool: ${name}`);
    }
}

export async function runCsvTool(name: string, args: Record<string, unknown>) {
    if (!csvToolsEnabled()) {
        throw new Error("CSV tools are disabled.");
    }
    switch (name) {
        case "csv_create_file":
            return csvOps.csvCreateFile(args);
        case "csv_read":
            return csvOps.csvRead(args);
        case "csv_append_rows":
            return csvOps.csvAppendRows(args);
        case "csv_filter_rows":
            return csvOps.csvFilterRows(args);
        case "csv_update_rows":
            return csvOps.csvUpdateRows(args);
        case "csv_delete_rows":
            return csvOps.csvDeleteRows(args);
        case "csv_column_totals":
            return csvOps.csvColumnTotals(args);
        default:
            throw new Error(`Unknown CSV tool: ${name}`);
    }
}
