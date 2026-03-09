import fs from "fs";
import path from "path";
import { ToolDefinition } from "./openrouter";

export const SYSTEM_TOOL_NAMES = [
  "system_list_dir",
  "system_read_file",
] as const;

const DEFAULT_LIST_LIMIT = 200;
const DEFAULT_MAX_READ_BYTES = 200000;

function systemToolsEnabled() {
  return process.env.SYSTEM_TOOLS_ENABLED !== "false";
}

function parsePositiveInt(value: unknown, fallback: number, min = 0) {
  const parsed =
    typeof value === "number" ? value : Number(value ?? Number.NaN);
  if (Number.isFinite(parsed) && parsed >= min) {
    return Math.floor(parsed);
  }
  return fallback;
}

function toStringValue(value: unknown) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return String(value);
}

function resolveSystemPath(input: string) {
  const trimmed = input.trim();
  if (!trimmed) {
    return process.cwd();
  }
  // Resolve against CWD if relative, otherwise absolute
  return path.resolve(process.cwd(), trimmed);
}

function toDisplayPath(absolutePath: string) {
  const relativePath = path.relative(process.cwd(), absolutePath);
  return relativePath.startsWith("..") ? absolutePath : relativePath;
}

async function resolveCaseInsensitiveExistingPath(targetPath: string) {
  const absolute = path.resolve(targetPath);
  const parsed = path.parse(absolute);
  const segments = absolute
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean);

  let current = parsed.root || path.sep;
  for (const segment of segments) {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      return null;
    }
    const exact = entries.find((entry) => entry.name === segment);
    if (exact) {
      current = path.join(current, exact.name);
      continue;
    }
    const fold = segment.toLowerCase();
    const caseInsensitive = entries.filter(
      (entry) => entry.name.toLowerCase() === fold
    );
    if (caseInsensitive.length !== 1) {
      return null;
    }
    current = path.join(current, caseInsensitive[0].name);
  }

  try {
    await fs.promises.stat(current);
    return current;
  } catch {
    return null;
  }
}

async function buildMissingPathHint(filePath: string) {
  const suggestedPath = await resolveCaseInsensitiveExistingPath(filePath);
  if (suggestedPath && suggestedPath !== filePath) {
    const displaySuggestion = toDisplayPath(suggestedPath);
    return {
      hint: `Linux paths are case-sensitive. Did you mean '${displaySuggestion}'?`,
      did_you_mean: displaySuggestion,
    };
  }
  const parent = path.dirname(filePath);
  return {
    hint: `Use system_list_dir on '${toDisplayPath(parent)}' and copy the exact filename casing.`,
  };
}

async function readFileLimited(filePath: string, maxBytes: number) {
  const stats = await fs.promises.stat(filePath);
  if (!stats.isFile()) {
    throw new Error("Path is not a file.");
  }
  const bytesToRead = Math.min(stats.size, maxBytes);
  const handle = await fs.promises.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
    return {
      content: buffer.toString("utf8", 0, bytesRead),
      truncated: stats.size > maxBytes,
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    };
  } finally {
    await handle.close();
  }
}

async function systemListDir(args: Record<string, unknown>) {
  try {
    const inputPath = toStringValue(args.path);
    const dirPath = resolveSystemPath(inputPath);
    
    try {
        const stats = await fs.promises.stat(dirPath);
        if (!stats.isDirectory()) {
        return { error: "Path is not a directory." };
        }
    } catch {
         return { error: "Path does not exist." };
    }

    const recursive = Boolean(args.recursive);
    const limit = parsePositiveInt(args.limit, DEFAULT_LIST_LIMIT, 1);
    const entries: Array<{
      path: string;
      name: string;
      type: "file" | "dir" | "other";
      size_bytes: number;
      modified_at: string;
    }> = [];

    const queue: string[] = [dirPath];
    // Safety break for recursive
    let loops = 0;
    
    while (queue.length > 0 && entries.length < limit && loops < 10000) {
      loops++;
      const current = queue.shift();
      if (!current) {
        break;
      }
      
      let dirents;
      try {
          dirents = await fs.promises.readdir(current, { withFileTypes: true });
      } catch {
          // Skip unreadable dirs
          continue;
      }

      for (const entry of dirents) {
        const fullPath = path.join(current, entry.name);
        let stat;
        try {
            stat = await fs.promises.stat(fullPath);
        } catch {
            continue;
        }

        // Return relative path to CWD for cleaner output if possible
        const relativePath = path.relative(process.cwd(), fullPath);
        const displayPath = relativePath.startsWith("..") ? fullPath : relativePath;

        entries.push({
          path: displayPath,
          name: entry.name,
          type: entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other",
          size_bytes: entry.isDirectory() ? 0 : stat.size,
          modified_at: stat.mtime.toISOString(),
        });

        if (entries.length >= limit) {
          break;
        }
        if (recursive && entry.isDirectory()) {
          queue.push(fullPath);
        }
      }
    }

    return {
      path: path.relative(process.cwd(), dirPath) || dirPath,
      entries,
      truncated: entries.length >= limit,
    };
  } catch (error) {
    return {
      error:
        error instanceof Error ? error.message : "Failed to list directory.",
    };
  }
}

async function systemReadFile(args: Record<string, unknown>) {
  try {
    const inputPath = toStringValue(args.path);
    if (!inputPath) return { error: "path is required" };
    
    const filePath = resolveSystemPath(inputPath);
    const maxBytes = parsePositiveInt(
      args.max_bytes,
      DEFAULT_MAX_READ_BYTES,
      1
    );
    
    try {
        const { content, truncated, size, modifiedAt } = await readFileLimited(
        filePath,
        maxBytes
        );
        return {
        path: toDisplayPath(filePath),
        content,
        bytes: size,
        truncated,
        modified_at: modifiedAt,
        };
    } catch (e) {
        const systemError = e as NodeJS.ErrnoException;
        if (systemError?.code === "ENOENT") {
          const attemptedPath = toDisplayPath(filePath);
          const hintData = await buildMissingPathHint(filePath);
          return {
            error: `Path does not exist: ${attemptedPath}`,
            ...hintData,
          };
        }
        return { error: e instanceof Error ? e.message : "File not found or unreadable." };
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Failed to read file.",
    };
  }
}

export function getSystemToolDefinitions(): ToolDefinition[] {
  if (!systemToolsEnabled()) {
    return [];
  }
  return [
    {
      type: "function",
      function: {
        name: "system_list_dir",
        description: "List files/directories in the system (container) filesystem. Read-only. Use this first to confirm exact path casing.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Absolute path or relative to CWD. Default is CWD.",
            },
            recursive: {
              type: "boolean",
              description: "Recursively list subdirectories (use with caution).",
            },
            limit: {
              type: "integer",
              description: "Max entries to return (default 200).",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "system_read_file",
        description: "Read a file from the system (container) filesystem. Read-only and case-sensitive on Linux paths.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Absolute path or path relative to CWD. Copy exact filename casing from system_list_dir.",
            },
            max_bytes: {
              type: "integer",
              description: "Max bytes to read (default 200k).",
            },
          },
          required: ["path"],
        },
      },
    },
  ];
}

export async function runSystemTool(name: string, args: Record<string, unknown>) {
  if (!systemToolsEnabled()) {
    throw new Error("System tools are disabled.");
  }
  switch (name) {
    case "system_list_dir":
      return systemListDir(args);
    case "system_read_file":
      return systemReadFile(args);
    default:
      throw new Error(`Unknown system tool: ${name}`);
  }
}

export function getSystemToolStatus() {
  if (!systemToolsEnabled()) {
    return [
      {
        id: "system-tools",
        label: "System Files",
        status: "error" as const,
        details: ["Disabled (SYSTEM_TOOLS_ENABLED=false)."],
      },
    ];
  }
  return [
    {
      id: "system-tools",
      label: "System Files",
      status: "ok" as const,
      details: [
        "Read-only access enabled.",
        "Use exact path casing on Linux.",
      ],
    },
  ];
}

export { systemToolsEnabled };
