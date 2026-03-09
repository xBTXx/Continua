import fs from "fs";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { XMLParser } from "fast-xml-parser";
import { ToolDefinition } from "./openrouter";

type ArxivToolStatus = {
  id: string;
  label: string;
  status: "ok" | "error";
  details: string[];
};

type ArxivToolDefinition = ToolDefinition;
type ArxivToolArguments = Record<string, unknown>;
type ParsedRecord = Record<string, unknown>;
type ArxivFeedEntry = {
  id: string;
  title: string;
  summary: string;
  published: string;
  updated: string;
  authors: string[];
  categories: string[];
  abs_url: string;
  pdf_url: string;
  source_url: string;
};
type ConverterResult = {
  status?: string;
  error?: string;
  method?: string | null;
  source?: string | null;
  word_count?: number | null;
};

export const ARXIV_TOOL_NAMES = ["arxiv_search", "arxiv_fetch"] as const;

const DEFAULT_API_BASE = "https://export.arxiv.org";
const DEFAULT_ARXIV_BASE = "https://arxiv.org";
const DEFAULT_USER_AGENT = "MemoryAssistant/1.0 (+https://localhost)";
const DEFAULT_WORKSPACE_ROOT = path.join(process.cwd(), "assistant_workspace");
const DEFAULT_WORKSPACE_DIR = "arxiv";
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 20;
const DEFAULT_TIMEOUT_MS = 20000;

const execFileAsync = promisify(execFile);
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  ignoreDeclaration: true,
  removeNSPrefix: true,
  trimValues: true,
});

export function arxivToolsEnabled() {
  return process.env.ARXIV_TOOLS_ENABLED !== "false";
}

function getApiBase() {
  return process.env.ARXIV_API_BASE || DEFAULT_API_BASE;
}

function getArxivBase() {
  return process.env.ARXIV_BASE_URL || DEFAULT_ARXIV_BASE;
}

function getUserAgent() {
  return process.env.ARXIV_USER_AGENT || DEFAULT_USER_AGENT;
}

function getWorkspaceDir() {
  return process.env.ARXIV_WORKSPACE_DIR || DEFAULT_WORKSPACE_DIR;
}

function resolveWorkspaceRoot() {
  return path.resolve(
    process.env.ASSISTANT_WORKSPACE_ROOT ?? DEFAULT_WORKSPACE_ROOT
  );
}

function normalizeInputPath(input: string) {
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

function resolveWorkspacePath(input: string) {
  const root = resolveWorkspaceRoot();
  const relative = normalizeInputPath(input);
  const resolved = path.resolve(root, relative);
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new Error("Path escapes workspace root.");
  }
  return resolved;
}

function toWorkspaceRelative(absPath: string) {
  const root = resolveWorkspaceRoot();
  const relative = path.relative(root, absPath);
  if (!relative || relative === ".") {
    return "/";
  }
  return `/${relative.split(path.sep).join("/")}`;
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function asArray<T>(value: T | T[] | undefined | null) {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function isParsedRecord(value: unknown): value is ParsedRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function slugify(input: string, fallback: string) {
  const ascii = input.normalize("NFKD").replace(/[^\x00-\x7F]/g, "");
  const slug = ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function normalizeArxivId(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  const match = trimmed.match(/arxiv\.org\/(abs|pdf|e-print)\/([^?#]+)/i);
  if (match) {
    return match[2].replace(/\.pdf$/i, "");
  }
  return trimmed.replace(/\.pdf$/i, "");
}

function buildSourceUrl(arxivId: string) {
  return `${getArxivBase()}/e-print/${arxivId}`;
}

function buildPdfUrl(arxivId: string) {
  return `${getArxivBase()}/pdf/${arxivId}.pdf`;
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function downloadToFile(url: string, destination: string) {
  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        Accept: "*/*",
        "User-Agent": getUserAgent(),
      },
    },
    DEFAULT_TIMEOUT_MS
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Download failed (${response.status}): ${text}`);
  }
  if (!response.body) {
    throw new Error("Download failed: empty body.");
  }
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.promises.writeFile(destination, buffer);
}

function parseFeed(xml: string): {
  totalResults: number;
  results: ArxivFeedEntry[];
} {
  const parsed = xmlParser.parse(xml) as ParsedRecord;
  const nestedFeed =
    parsed.feed && typeof parsed.feed === "object" && !Array.isArray(parsed.feed)
      ? (parsed.feed as ParsedRecord)
      : null;
  const feed = nestedFeed ?? parsed;
  const entries = asArray(feed.entry).filter(isParsedRecord);
  const totalRaw =
    feed.totalResults ??
    feed.opensearch_totalResults ??
    feed["opensearch:totalResults"];
  const totalResults = Number.isFinite(Number(totalRaw))
    ? Number(totalRaw)
    : entries.length;

  const results = entries.map((entry) => {
    const idUrl = typeof entry?.id === "string" ? entry.id : "";
    const arxivId = normalizeArxivId(idUrl);
    const titleRaw = typeof entry?.title === "string" ? entry.title : "";
    const summaryRaw = typeof entry?.summary === "string" ? entry.summary : "";
    const title = normalizeWhitespace(titleRaw);
    const summary = normalizeWhitespace(summaryRaw);
    const published =
      typeof entry?.published === "string" ? entry.published : "";
    const updated = typeof entry?.updated === "string" ? entry.updated : "";
    const authors = asArray(entry.author).filter(isParsedRecord).map((author) => {
      const name = typeof author?.name === "string" ? author.name : "";
      return normalizeWhitespace(name);
    });
    const categories = asArray(entry.category)
      .filter(isParsedRecord)
      .map((cat) => {
        const term = cat?.["@_term"] ?? cat?.term;
        return typeof term === "string" ? term : "";
      })
      .filter((term) => term.length > 0);
    const links = asArray(entry.link).filter(isParsedRecord);
    const absUrlCandidate =
      links.find((link) => link?.["@_rel"] === "alternate")?.["@_href"] ?? idUrl;
    const absUrl = typeof absUrlCandidate === "string" ? absUrlCandidate : idUrl;
    const pdfUrlCandidate =
      links.find(
        (link) =>
          link?.["@_title"] === "pdf" ||
          link?.["@_type"] === "application/pdf" ||
          String(link?.["@_href"] || "").includes("/pdf/")
      )?.["@_href"] ?? (arxivId ? buildPdfUrl(arxivId) : "");
    const pdfUrl = typeof pdfUrlCandidate === "string" ? pdfUrlCandidate : "";
    return {
      id: arxivId,
      title,
      summary,
      published,
      updated,
      authors,
      categories,
      abs_url: absUrl,
      pdf_url: pdfUrl,
      source_url: arxivId ? buildSourceUrl(arxivId) : "",
    };
  });

  return { totalResults, results };
}

async function fetchArxivEntry(arxivId: string): Promise<ArxivFeedEntry | null> {
  const url = new URL("/api/query", getApiBase());
  url.searchParams.set("id_list", arxivId);
  url.searchParams.set("max_results", "1");
  const response = await fetchWithTimeout(url.toString(), {
    headers: {
      Accept: "application/atom+xml",
      "User-Agent": getUserAgent(),
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`arXiv lookup failed (${response.status}): ${text}`);
  }
  const xml = await response.text();
  const { results } = parseFeed(xml);
  return results[0] ?? null;
}

function resolvePythonBin() {
  const configured = process.env.ARXIV_PYTHON_BIN;
  if (configured && configured.trim()) {
    return configured.trim();
  }
  return "python3";
}

async function runConverter(args: {
  sourcePath?: string;
  pdfPath?: string;
  outputPath: string;
}) {
  const scriptPath = path.join(process.cwd(), "scripts", "arxiv_convert.py");
  if (!fs.existsSync(scriptPath)) {
    throw new Error("arXiv converter script not found.");
  }
  const params = [scriptPath, "--out", args.outputPath];
  if (args.sourcePath) {
    params.push("--source", args.sourcePath);
  }
  if (args.pdfPath) {
    params.push("--pdf", args.pdfPath);
  }
  const pythonBins = [resolvePythonBin(), "python"];
  let lastError: Error | null = null;
  for (const pythonBin of pythonBins) {
    try {
      const { stdout } = await execFileAsync(pythonBin, params, {
        maxBuffer: 10 * 1024 * 1024,
      });
      const parsed = JSON.parse(stdout) as ConverterResult;
      if (parsed?.status !== "ok") {
        throw new Error(parsed?.error || "Conversion failed.");
      }
      return parsed;
    } catch (error: unknown) {
      const isMissing =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof (error as { code?: unknown }).code === "string" &&
        (error as { code: string }).code === "ENOENT";
      if (isMissing) {
        lastError = new Error(`Python executable not found: ${pythonBin}`);
        continue;
      }
      const stderr =
        typeof error === "object" &&
        error !== null &&
        "stderr" in error &&
        typeof (error as { stderr?: unknown }).stderr === "string"
          ? (error as { stderr: string }).stderr.trim()
          : "";
      const message =
        error instanceof Error ? error.message : "Conversion failed.";
      throw new Error(stderr ? `${message} ${stderr}` : message);
    }
  }
  if (lastError) {
    throw lastError;
  }
  throw new Error("Python executable not found.");
}

function yamlString(value: string) {
  const cleaned = value.replace(/\r?\n/g, " ").trim();
  const escaped = cleaned.replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function buildFrontMatter(entry: {
  id: string;
  title?: string;
  published?: string;
  updated?: string;
  abs_url?: string;
  pdf_url?: string;
  source_url?: string;
  categories?: string[];
  method?: string;
  used_source?: string;
}) {
  const lines: string[] = ["---", 'source: "arxiv"', `arxiv_id: ${yamlString(entry.id)}`];
  if (entry.title) {
    lines.push(`title: ${yamlString(entry.title)}`);
  }
  if (entry.published) {
    lines.push(`published: ${yamlString(entry.published)}`);
  }
  if (entry.updated) {
    lines.push(`updated: ${yamlString(entry.updated)}`);
  }
  if (entry.abs_url) {
    lines.push(`abs_url: ${yamlString(entry.abs_url)}`);
  }
  if (entry.pdf_url) {
    lines.push(`pdf_url: ${yamlString(entry.pdf_url)}`);
  }
  if (entry.source_url) {
    lines.push(`source_url: ${yamlString(entry.source_url)}`);
  }
  if (entry.categories && entry.categories.length > 0) {
    lines.push(`categories: [${entry.categories.map(yamlString).join(", ")}]`);
  }
  if (entry.method) {
    lines.push(`extracted_with: ${yamlString(entry.method)}`);
  }
  if (entry.used_source) {
    lines.push(`extraction_source: ${yamlString(entry.used_source)}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

export function getArxivToolDefinitions(): ArxivToolDefinition[] {
  if (!arxivToolsEnabled()) {
    return [];
  }

  return [
    {
      type: "function",
      function: {
        name: "arxiv_search",
        description: "Search arXiv for papers.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query (free-form).",
            },
            search_query: {
              type: "string",
              description:
                "Raw arXiv API search_query (e.g., 'ti:transformer AND cat:cs.CL').",
            },
            start: {
              type: "integer",
              minimum: 0,
              description: "Result offset (default 0).",
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 20,
              description: "Max results (default 5).",
            },
            sort_by: {
              type: "string",
              description:
                "Sort by relevance, lastUpdatedDate, or submittedDate.",
            },
            sort_order: {
              type: "string",
              description: "Sort order: ascending or descending.",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "arxiv_fetch",
        description:
          "Fetch an arXiv paper, convert it to Markdown, and save it in the workspace.",
        parameters: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "arXiv identifier or URL.",
            },
            folder: {
              type: "string",
              description:
                "Workspace-relative folder to store papers (default /arxiv).",
            },
            filename: {
              type: "string",
              description: "Optional filename (without extension).",
            },
            keep_files: {
              type: "boolean",
              description:
                "Keep downloaded source/PDF files alongside the Markdown.",
            },
            prefer_source: {
              type: "boolean",
              description:
                "Prefer LaTeX source conversion before PDF fallback (default true).",
            },
          },
          required: ["id"],
        },
      },
    },
  ];
}

export function getArxivToolStatus(): ArxivToolStatus[] {
  if (!arxivToolsEnabled()) {
    return [
      {
        id: "arxiv-tools",
        label: "arXiv",
        status: "error",
        details: ["Disabled (ARXIV_TOOLS_ENABLED=false)."],
      },
    ];
  }
  return [
    {
      id: "arxiv-tools",
      label: "arXiv",
      status: "ok",
      details: [
        `API: ${getApiBase()}`,
        `Workspace: /${getWorkspaceDir()}`,
      ],
    },
  ];
}

export async function runArxivTool(name: string, args: ArxivToolArguments) {
  if (!arxivToolsEnabled()) {
    throw new Error("arXiv tools are disabled.");
  }

  switch (name) {
    case "arxiv_search": {
      const rawQuery = typeof args.query === "string" ? args.query.trim() : "";
      const rawSearchQuery =
        typeof args.search_query === "string" ? args.search_query.trim() : "";
      const query = rawSearchQuery || rawQuery;
      if (!query) {
        throw new Error("arxiv_search requires a query.");
      }
      const searchQuery =
        rawSearchQuery || (query.includes(":") ? query : `all:${query}`);
      const startRaw = typeof args.start === "number" ? args.start : 0;
      const limitRaw =
        typeof args.limit === "number" ? args.limit : DEFAULT_SEARCH_LIMIT;
      const start = Math.max(0, Math.floor(Number(startRaw) || 0));
      const limit = Math.min(
        MAX_SEARCH_LIMIT,
        Math.max(1, Math.floor(Number(limitRaw) || DEFAULT_SEARCH_LIMIT))
      );
      const sortByRaw =
        typeof args.sort_by === "string" ? args.sort_by.trim() : "";
      const sortBy = sortByRaw || "relevance";
      const sortOrderRaw =
        typeof args.sort_order === "string" ? args.sort_order.trim() : "";
      const sortOrder = sortOrderRaw || "descending";

      const url = new URL("/api/query", getApiBase());
      url.searchParams.set("search_query", searchQuery);
      url.searchParams.set("start", String(start));
      url.searchParams.set("max_results", String(limit));
      if (sortBy) {
        url.searchParams.set("sortBy", sortBy);
      }
      if (sortOrder) {
        url.searchParams.set("sortOrder", sortOrder);
      }

      const response = await fetchWithTimeout(url.toString(), {
        headers: {
          Accept: "application/atom+xml",
          "User-Agent": getUserAgent(),
        },
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`arXiv search failed (${response.status}): ${text}`);
      }
      const xml = await response.text();
      const { totalResults, results } = parseFeed(xml);
      return {
        query: searchQuery,
        start,
        limit,
        total_results: totalResults,
        results,
      };
    }
    case "arxiv_fetch": {
      const rawId = typeof args.id === "string" ? args.id : "";
      const arxivId = normalizeArxivId(rawId);
      if (!arxivId) {
        throw new Error("arxiv_fetch requires an arXiv id.");
      }

      const preferSource = args.prefer_source !== false;
      const keepFiles = args.keep_files === true;
      const folderRaw =
        typeof args.folder === "string" && args.folder.trim()
          ? args.folder.trim()
          : getWorkspaceDir();
      const outputDir = resolveWorkspacePath(folderRaw);
      await fs.promises.mkdir(outputDir, { recursive: true });

      const entry = await fetchArxivEntry(arxivId);
      const title =
        typeof entry?.title === "string" && entry.title.trim()
          ? entry.title.trim()
          : arxivId;
      const safeId = slugify(arxivId.replace(/[\\/]+/g, "-"), "arxiv");
      const paperDir = path.join(outputDir, safeId);
      await fs.promises.mkdir(paperDir, { recursive: true });

      const filenameRaw =
        typeof args.filename === "string" ? args.filename.trim() : "";
      const baseName = filenameRaw || title;
      const fileSlug = slugify(baseName, safeId);
      const outputPath = path.join(paperDir, `${fileSlug}.md`);

      const tempDir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "arxiv-")
      );
      let sourcePath: string | null = null;
      let pdfPath: string | null = null;
      const warnings: string[] = [];

      try {
        if (preferSource) {
          sourcePath = path.join(tempDir, "source.eprint");
          try {
            await downloadToFile(buildSourceUrl(arxivId), sourcePath);
          } catch (error) {
            warnings.push(
              error instanceof Error
                ? `Source download failed: ${error.message}`
                : "Source download failed."
            );
            sourcePath = null;
          }
        }

        let conversionResult: ConverterResult | null = null;
        if (sourcePath) {
          try {
            conversionResult = await runConverter({
              sourcePath,
              outputPath,
            });
          } catch (error) {
            warnings.push(
              error instanceof Error
                ? `Source conversion failed: ${error.message}`
                : "Source conversion failed."
            );
          }
        }

        if (!conversionResult) {
          pdfPath = path.join(tempDir, "paper.pdf");
          await downloadToFile(
            entry?.pdf_url || buildPdfUrl(arxivId),
            pdfPath
          );
          conversionResult = await runConverter({
            pdfPath,
            outputPath,
          });
        }

        if (keepFiles) {
          if (sourcePath) {
            await fs.promises.copyFile(
              sourcePath,
              path.join(paperDir, "source.eprint")
            );
          }
          if (pdfPath) {
            await fs.promises.copyFile(
              pdfPath,
              path.join(paperDir, "paper.pdf")
            );
          }
        }

        const rawContent = await fs.promises.readFile(outputPath, "utf8");
        const frontMatter = buildFrontMatter({
          id: arxivId,
          title,
          published: entry?.published,
          updated: entry?.updated,
          abs_url: entry?.abs_url,
          pdf_url: entry?.pdf_url,
          source_url: entry?.source_url ?? buildSourceUrl(arxivId),
          categories: entry?.categories ?? [],
          method: conversionResult?.method ?? undefined,
          used_source: conversionResult?.source ?? undefined,
        });
        const content = rawContent.trim();
        await fs.promises.writeFile(
          outputPath,
          `${frontMatter}${content}\n`,
          "utf8"
        );

        return {
          id: arxivId,
          title,
          workspace_path: toWorkspaceRelative(outputPath),
          folder: toWorkspaceRelative(paperDir),
          pdf_url: entry?.pdf_url ?? buildPdfUrl(arxivId),
          source_url: entry?.source_url ?? buildSourceUrl(arxivId),
          method: conversionResult?.method ?? null,
          extraction_source: conversionResult?.source ?? null,
          word_count: conversionResult?.word_count ?? null,
          warnings,
        };
      } finally {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
      }
    }
    default:
      throw new Error(`Unknown arXiv tool: ${name}`);
  }
}
