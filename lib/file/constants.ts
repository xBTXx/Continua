import path from "path";

export const DOC_TOOL_NAMES = [
    "doc_create_file",
    "doc_read_file",
    "doc_update_file",
    "doc_apply_patch",
    "fs_bulk_manager",
    "doc_delete_file",
    "doc_list_dir",
    "doc_search",
    "doc_create_dir",
    "doc_stat",
    "doc_move",
    "doc_copy",
    "doc_rename",
    "doc_list_trash",
    "doc_restore",
] as const;

export const CSV_TOOL_NAMES = [
    "csv_create_file",
    "csv_read",
    "csv_append_rows",
    "csv_filter_rows",
    "csv_update_rows",
    "csv_delete_rows",
    "csv_column_totals",
] as const;

export const DEFAULT_DOC_EXTENSIONS = new Set([".md", ".txt"]);
export const CSV_EXTENSION = ".csv";
export const DEFAULT_SEARCHABLE_EXTENSIONS = new Set([".md", ".txt", ".csv"]);
export const DEFAULT_ALLOW_ANY_DOC_EXTENSIONS = true;
export const DEFAULT_ALLOW_ANY_SEARCH_EXTENSIONS = true;
export const DEFAULT_WORKSPACE_ROOT = path.join(process.cwd(), "assistant_workspace");
export const DEFAULT_RECYCLE_DAYS = 30;
export const DEFAULT_MAX_READ_BYTES = 200000;
export const DEFAULT_MAX_SEARCH_BYTES = 500000;
export const DEFAULT_LIST_LIMIT = 200;
export const DEFAULT_SEARCH_LIMIT = 50;
