import { ToolDefinition } from "../openrouter";
import { docToolsEnabled, csvToolsEnabled } from "./utils";

export function getDocToolDefinitions(): ToolDefinition[] {
    if (!docToolsEnabled()) {
        return [];
    }
    return [
        {
            type: "function",
            function: {
                name: "doc_create_file",
                description:
                    "Create a new file inside the workspace root (extensions configurable).",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description:
                                "Workspace-relative path for the file (leading / is ok).",
                        },
                        content: { type: "string", description: "File content." },
                        encoding: {
                            type: "string",
                            description: "Content encoding (utf8 or base64).",
                        },
                        overwrite: {
                            type: "boolean",
                            description: "Overwrite if the file already exists.",
                        },
                    },
                    required: ["path", "content"],
                },
            },
        },
        {
            type: "function",
            function: {
                name: "doc_read_file",
                description:
                    "Read a file from workspace/project paths or absolute system paths (extensions configurable).",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description:
                                "Path to a file. Supports workspace-relative, project-relative, and absolute system paths.",
                        },
                        max_bytes: {
                            type: "integer",
                            description: "Max bytes to read (default 200k).",
                        },
                        offset: {
                            type: "integer",
                            description: "Byte offset to start reading from (default 0).",
                        },
                        encoding: {
                            type: "string",
                            description: "Content encoding to return (utf8 or base64).",
                        },
                    },
                    required: ["path"],
                },
            },
        },
        {
            type: "function",
            function: {
                name: "doc_update_file",
                description:
                    "Update a workspace file (append, overwrite, replace, insert, range, regex).",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description:
                                "Workspace-relative path to a file (leading / is ok).",
                        },
                        mode: {
                            type: "string",
                            enum: [
                                "append",
                                "overwrite",
                                "replace",
                                "replace_regex",
                                "insert_before",
                                "insert_after",
                                "insert_at",
                                "replace_range",
                            ],
                        },
                        content: { type: "string", description: "Content to write." },
                        encoding: {
                            type: "string",
                            description: "Content encoding for append/overwrite (utf8 or base64).",
                        },
                        create_if_missing: {
                            type: "boolean",
                            description: "Create the file if it is missing (append mode).",
                        },
                        find: {
                            type: "string",
                            description: "Text to replace (replace mode).",
                        },
                        replace: {
                            type: "string",
                            description: "Replacement text (replace/regex modes).",
                        },
                        replace_all: {
                            type: "boolean",
                            description: "Replace all occurrences (replace/regex modes).",
                        },
                        pattern: {
                            type: "string",
                            description: "Regex pattern (replace_regex mode).",
                        },
                        flags: {
                            type: "string",
                            description: "Regex flags (replace_regex mode).",
                        },
                        target: {
                            type: "string",
                            description: "Target text to insert before/after (insert mode).",
                        },
                        occurrence: {
                            type: "integer",
                            description: "Which occurrence of find/target to affect (1-based).",
                        },
                        index: {
                            type: "integer",
                            description: "Character index for insert_at (0-based).",
                        },
                        start: {
                            type: "integer",
                            description: "Start offset for replace_range (0-based).",
                        },
                        end: {
                            type: "integer",
                            description: "End offset for replace_range (0-based, exclusive).",
                        },
                        length: {
                            type: "integer",
                            description: "Length for replace_range when end is omitted.",
                        },
                    },
                    required: ["path", "mode"],
                },
            },
        },
        {
            type: "function",
            function: {
                name: "doc_apply_patch",
                description:
                    "Apply a unified-diff patch to existing workspace files for precise edits.",
                parameters: {
                    type: "object",
                    properties: {
                        patch: {
                            type: "string",
                            description:
                                "Unified diff text with ---/+++ file headers and @@ hunks. In each hunk, old count=context+removed lines and new count=context+added lines.",
                        },
                        path: {
                            type: "string",
                            description:
                                "Optional workspace-relative file path to constrain the patch target.",
                        },
                        strip: {
                            type: "integer",
                            description:
                                "Optional path segment strip count for diff headers (like patch -p). Defaults to auto-detect for a/ and b/ prefixes.",
                        },
                    },
                    required: ["patch"],
                },
            },
        },
        {
            type: "function",
            function: {
                name: "fs_bulk_manager",
                description:
                    "Search/filter files in bulk, then preview or apply bulk move/copy/text-replacement operations with workspace safety.",
                parameters: {
                    type: "object",
                    properties: {
                        action: {
                            type: "string",
                            enum: ["search", "move", "copy", "replace"],
                            description:
                                "Bulk operation to perform. search only lists matches; move/copy/replace support preview via apply=false.",
                        },
                        path: {
                            type: "string",
                            description:
                                "Search root. search can inspect workspace/project/absolute paths; move/copy/replace stay workspace-rooted.",
                        },
                        query: {
                            type: "string",
                            description:
                                "Optional text or regex pattern to match against file names and/or file contents.",
                        },
                        mode: {
                            type: "string",
                            enum: ["name", "content", "both"],
                            description:
                                "Where to match query. replace requires content or both.",
                        },
                        case_sensitive: {
                            type: "boolean",
                            description: "Case-sensitive matching.",
                        },
                        use_regex: {
                            type: "boolean",
                            description: "Treat query as a regex pattern.",
                        },
                        flags: {
                            type: "string",
                            description: "Regex flags when use_regex is true.",
                        },
                        extensions: {
                            type: "array",
                            items: { type: "string" },
                            description:
                                "Optional file extensions to include (for example ['.md', '.txt']). Use * for all.",
                        },
                        exclude_dirs: {
                            type: "array",
                            items: { type: "string" },
                            description:
                                "Directory names or relative paths to skip during traversal.",
                        },
                        include_hidden: {
                            type: "boolean",
                            description: "Include dotfiles and dot-directories.",
                        },
                        include_trash: {
                            type: "boolean",
                            description: "Include recycle-bin contents.",
                        },
                        max_depth: {
                            type: "integer",
                            description: "Max recursion depth when searching directories.",
                        },
                        max_file_bytes: {
                            type: "integer",
                            description:
                                "Skip content reads for files larger than this byte size.",
                        },
                        modified_within_hours: {
                            type: "integer",
                            description:
                                "Only include files modified within the last N hours.",
                        },
                        created_within_hours: {
                            type: "integer",
                            description:
                                "Only include files created within the last N hours.",
                        },
                        limit: {
                            type: "integer",
                            description: "Max matched files to return/process (default 50).",
                        },
                        offset: {
                            type: "integer",
                            description: "Skip this many matched files before returning results.",
                        },
                        destination_path: {
                            type: "string",
                            description:
                                "Required for move/copy. Workspace-relative destination directory.",
                        },
                        preserve_structure: {
                            type: "boolean",
                            description:
                                "For move/copy, preserve each match's path relative to path inside destination_path (default true).",
                        },
                        overwrite: {
                            type: "boolean",
                            description:
                                "For move/copy, overwrite destination files by recycling the existing path first.",
                        },
                        apply: {
                            type: "boolean",
                            description:
                                "For move/copy/replace, set true to execute changes. Default false returns a preview only.",
                        },
                        replace: {
                            type: "string",
                            description:
                                "Replacement text for action=replace.",
                        },
                        replace_all: {
                            type: "boolean",
                            description:
                                "For action=replace, replace all matches in each file (default true).",
                        },
                    },
                    required: ["action"],
                },
            },
        },
        {
            type: "function",
            function: {
                name: "doc_delete_file",
                description:
                    "Delete a file or folder inside the workspace (moves to recycle bin).",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description: "Workspace-relative path to delete.",
                        },
                        recursive: {
                            type: "boolean",
                            description: "Allow deleting non-empty directories.",
                        },
                    },
                    required: ["path"],
                },
            },
        },
        {
            type: "function",
            function: {
                name: "doc_list_dir",
                description:
                    "List files/folders from workspace/project paths or absolute system paths.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description:
                                "Directory path to inspect (default /). Supports workspace/project paths and absolute system paths.",
                        },
                        recursive: {
                            type: "boolean",
                            description: "Recursively list subdirectories.",
                        },
                        include_hidden: {
                            type: "boolean",
                            description: "Include dotfiles.",
                        },
                        include_trash: {
                            type: "boolean",
                            description: "Include recycle bin entries.",
                        },
                        limit: {
                            type: "integer",
                            description: "Max entries to return (default 200).",
                        },
                        offset: {
                            type: "integer",
                            description: "Offset before returning entries (default 0).",
                        },
                        max_depth: {
                            type: "integer",
                            description: "Max recursion depth when recursive (default unlimited).",
                        },
                    },
                },
            },
        },
        {
            type: "function",
            function: {
                name: "doc_search",
                description:
                    "Search file names or contents in workspace/project paths or absolute system paths.",
                parameters: {
                    type: "object",
                    properties: {
                        query: { type: "string", description: "Search query." },
                        path: {
                            type: "string",
                            description:
                                "Path to search (default /). Supports workspace/project paths and absolute system paths.",
                        },
                        mode: {
                            type: "string",
                            enum: ["name", "content", "both"],
                            description: "Search by file name, content, or both.",
                        },
                        case_sensitive: {
                            type: "boolean",
                            description: "Case-sensitive matching.",
                        },
                        include_hidden: {
                            type: "boolean",
                            description: "Include dotfiles.",
                        },
                        include_trash: {
                            type: "boolean",
                            description: "Include recycle bin contents.",
                        },
                        max_file_bytes: {
                            type: "integer",
                            description: "Skip files larger than this byte size.",
                        },
                        limit: {
                            type: "integer",
                            description: "Max results to return (default 50).",
                        },
                        offset: {
                            type: "integer",
                            description: "Offset before returning results (default 0).",
                        },
                        max_depth: {
                            type: "integer",
                            description: "Max recursion depth when searching directories.",
                        },
                        extensions: {
                            type: "array",
                            items: { type: "string" },
                            description: "File extensions to search content in (use * for all).",
                        },
                        exclude_dirs: {
                            type: "array",
                            items: { type: "string" },
                            description: "Directory names or paths to skip.",
                        },
                        use_regex: {
                            type: "boolean",
                            description: "Treat query as a regex pattern.",
                        },
                        flags: {
                            type: "string",
                            description: "Regex flags when use_regex is true.",
                        },
                    },
                    required: ["query"],
                },
            },
        },
        {
            type: "function",
            function: {
                name: "doc_create_dir",
                description: "Create a new workspace directory.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description: "Workspace-relative directory path.",
                        },
                        recursive: {
                            type: "boolean",
                            description: "Create parent folders if missing (default true).",
                        },
                    },
                    required: ["path"],
                },
            },
        },
        {
            type: "function",
            function: {
                name: "doc_stat",
                description: "Get file or directory metadata.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description:
                                "Path to inspect. Supports workspace/project paths and absolute system paths.",
                        },
                    },
                    required: ["path"],
                },
            },
        },
        {
            type: "function",
            function: {
                name: "doc_move",
                description: "Move or rename a file/folder in the workspace.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description: "Workspace-relative source path.",
                        },
                        destination_path: {
                            type: "string",
                            description: "Workspace-relative destination path.",
                        },
                        overwrite: {
                            type: "boolean",
                            description: "Overwrite destination if it exists.",
                        },
                    },
                    required: ["path", "destination_path"],
                },
            },
        },
        {
            type: "function",
            function: {
                name: "doc_copy",
                description: "Copy a file/folder in the workspace.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description: "Workspace-relative source path.",
                        },
                        destination_path: {
                            type: "string",
                            description: "Workspace-relative destination path.",
                        },
                        overwrite: {
                            type: "boolean",
                            description: "Overwrite destination if it exists.",
                        },
                        recursive: {
                            type: "boolean",
                            description: "Copy directories recursively (default true).",
                        },
                    },
                    required: ["path", "destination_path"],
                },
            },
        },
        {
            type: "function",
            function: {
                name: "doc_rename",
                description: "Rename a file/folder (within the same directory).",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description: "Workspace-relative path to rename.",
                        },
                        new_name: {
                            type: "string",
                            description: "New base name (no path separators).",
                        },
                        overwrite: {
                            type: "boolean",
                            description: "Overwrite destination if it exists.",
                        },
                    },
                    required: ["path", "new_name"],
                },
            },
        },
        {
            type: "function",
            function: {
                name: "doc_list_trash",
                description: "List recycle bin entries.",
                parameters: {
                    type: "object",
                    properties: {
                        limit: {
                            type: "integer",
                            description: "Max entries to return (default 200).",
                        },
                        offset: {
                            type: "integer",
                            description: "Offset before returning entries (default 0).",
                        },
                    },
                },
            },
        },
        {
            type: "function",
            function: {
                name: "doc_restore",
                description: "Restore a file/folder from the recycle bin.",
                parameters: {
                    type: "object",
                    properties: {
                        recycle_id: {
                            type: "string",
                            description: "Recycle bin id to restore.",
                        },
                        original_path: {
                            type: "string",
                            description: "Original workspace-relative path to restore.",
                        },
                        path: {
                            type: "string",
                            description: "Alias for original_path.",
                        },
                        destination_path: {
                            type: "string",
                            description: "Optional destination path (defaults to original).",
                        },
                        overwrite: {
                            type: "boolean",
                            description: "Overwrite destination if it exists.",
                        },
                    },
                },
            },
        },
    ];
}

export function getCsvToolDefinitions(): ToolDefinition[] {
    if (!csvToolsEnabled()) {
        return [];
    }
    return [
        {
            type: "function",
            function: {
                name: "csv_create_file",
                description: "Create a new CSV file with headers (and optional rows).",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description:
                                "Workspace-relative path for the .csv file (leading / is ok).",
                        },
                        headers: {
                            type: "array",
                            items: { type: "string" },
                            description: "Column headers.",
                        },
                        rows: {
                            type: "array",
                            items: {},
                            description:
                                "Optional rows as arrays (aligned to headers) or objects.",
                        },
                        overwrite: {
                            type: "boolean",
                            description: "Overwrite if the file already exists.",
                        },
                        delimiter: {
                            type: "string",
                            description: "Delimiter character (default comma).",
                        },
                    },
                    required: ["path", "headers"],
                },
            },
        },
        {
            type: "function",
            function: {
                name: "csv_read",
                description: "Read rows from a CSV file.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description: "Workspace-relative path to the .csv file.",
                        },
                        offset: { type: "integer", description: "Row offset." },
                        limit: { type: "integer", description: "Max rows to return." },
                        as_objects: {
                            type: "boolean",
                            description: "Return rows as objects keyed by headers.",
                        },
                        delimiter: {
                            type: "string",
                            description: "Delimiter character (default comma).",
                        },
                    },
                    required: ["path"],
                },
            },
        },
        {
            type: "function",
            function: {
                name: "csv_append_rows",
                description: "Append one or more rows to a CSV file.",
                parameters: {
                    type: "object",
                    properties: {
                        path: { type: "string", description: "CSV file path." },
                        rows: {
                            type: "array",
                            items: {},
                            description: "Rows as arrays or objects.",
                        },
                        delimiter: {
                            type: "string",
                            description: "Delimiter character (default comma).",
                        },
                    },
                    required: ["path", "rows"],
                },
            },
        },
        {
            type: "function",
            function: {
                name: "csv_filter_rows",
                description: "Filter rows by exact match or contains.",
                parameters: {
                    type: "object",
                    properties: {
                        path: { type: "string", description: "CSV file path." },
                        where: {
                            type: "object",
                            description: "Exact-match filters (column -> value).",
                        },
                        contains: {
                            type: "object",
                            description: "Substring filters (column -> value).",
                        },
                        offset: { type: "integer", description: "Row offset." },
                        limit: { type: "integer", description: "Max rows to return." },
                        as_objects: {
                            type: "boolean",
                            description: "Return rows as objects keyed by headers.",
                        },
                        case_sensitive: { type: "boolean" },
                        delimiter: {
                            type: "string",
                            description: "Delimiter character (default comma).",
                        },
                    },
                    required: ["path"],
                },
            },
        },
        {
            type: "function",
            function: {
                name: "csv_update_rows",
                description: "Update rows by index or filters.",
                parameters: {
                    type: "object",
                    properties: {
                        path: { type: "string", description: "CSV file path." },
                        row_index: {
                            type: "integer",
                            description: "1-based row index to update (data rows only).",
                        },
                        row_indices: {
                            type: "array",
                            items: { type: "integer" },
                            description: "Multiple 1-based row indices.",
                        },
                        where: {
                            type: "object",
                            description: "Exact-match filters (column -> value).",
                        },
                        contains: {
                            type: "object",
                            description: "Substring filters (column -> value).",
                        },
                        set: {
                            type: "object",
                            description: "Columns to update (column -> new value).",
                        },
                        return_limit: {
                            type: "integer",
                            description: "Max updated rows to return (default 5).",
                        },
                        case_sensitive: { type: "boolean" },
                        delimiter: {
                            type: "string",
                            description: "Delimiter character (default comma).",
                        },
                    },
                    required: ["path", "set"],
                },
            },
        },
        {
            type: "function",
            function: {
                name: "csv_delete_rows",
                description: "Delete rows by index or filters.",
                parameters: {
                    type: "object",
                    properties: {
                        path: { type: "string", description: "CSV file path." },
                        row_index: {
                            type: "integer",
                            description: "1-based row index to delete (data rows only).",
                        },
                        row_indices: {
                            type: "array",
                            items: { type: "integer" },
                            description: "Multiple 1-based row indices.",
                        },
                        where: {
                            type: "object",
                            description: "Exact-match filters (column -> value).",
                        },
                        contains: {
                            type: "object",
                            description: "Substring filters (column -> value).",
                        },
                        case_sensitive: { type: "boolean" },
                        delimiter: {
                            type: "string",
                            description: "Delimiter character (default comma).",
                        },
                    },
                    required: ["path"],
                },
            },
        },
        {
            type: "function",
            function: {
                name: "csv_column_totals",
                description: "Calculate numeric column totals for a CSV file.",
                parameters: {
                    type: "object",
                    properties: {
                        path: { type: "string", description: "CSV file path." },
                        columns: {
                            type: "array",
                            items: { type: "string" },
                            description: "Columns to total (defaults to all).",
                        },
                        delimiter: {
                            type: "string",
                            description: "Delimiter character (default comma).",
                        },
                    },
                    required: ["path"],
                },
            },
        },
    ];
}
