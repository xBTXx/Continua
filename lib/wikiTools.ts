type WikiToolStatus = {
  id: string;
  label: string;
  status: "ok" | "error";
  details: string[];
};

type WikiToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

type WikiToolArguments = Record<string, unknown>;
type WikiSearchEntry = {
  title?: string;
  pageid?: number | null;
  snippet?: string;
};
type WikiPage = {
  title?: string;
  pageid?: number | null;
  extract?: string;
  missing?: boolean;
};
type WikiSearchResponse = {
  query?: {
    search?: WikiSearchEntry[];
    searchinfo?: {
      totalhits?: number;
    };
    pages?: WikiPage[];
  };
};
type WikiSummaryResponse = {
  title?: string;
  extract?: string;
  description?: string;
  detail?: string;
  content_urls?: {
    desktop?: {
      page?: string;
    };
  };
};

export const WIKI_TOOL_NAMES = [
  "wiki_search",
  "wiki_summary",
  "wiki_page",
] as const;

const DEFAULT_BASE_URL = "https://en.wikipedia.org";
const DEFAULT_USER_AGENT = "MemoryAssistant/1.0 (+https://localhost)";

function getWikiBaseUrl() {
  return process.env.WIKI_BASE_URL || DEFAULT_BASE_URL;
}

function getWikiUserAgent() {
  return process.env.WIKI_USER_AGENT || DEFAULT_USER_AGENT;
}

function normalizeTitle(title: string) {
  return title.trim().replace(/\s+/g, " ").replace(/ /g, "_");
}

function buildPageUrl(title: string) {
  const normalized = normalizeTitle(title);
  return new URL(`/wiki/${encodeURIComponent(normalized)}`, getWikiBaseUrl())
    .toString();
}

function buildApiUrl(path: string, params: Record<string, string | number>) {
  const url = new URL(path, getWikiBaseUrl());
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") {
      return;
    }
    url.searchParams.set(key, String(value));
  });
  return url;
}

function stripHtml(value: string) {
  return value.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

async function fetchJson(url: URL) {
  const response = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "User-Agent": getWikiUserAgent(),
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Wikipedia request failed (${response.status}): ${text}`);
  }
  return response.json() as Promise<Record<string, unknown>>;
}

export function wikiToolsEnabled() {
  return process.env.WIKI_TOOLS_ENABLED !== "false";
}

export function getWikiToolStatus(): WikiToolStatus[] {
  if (!wikiToolsEnabled()) {
    return [
      {
        id: "wiki-tools",
        label: "Wikipedia",
        status: "error",
        details: ["Disabled (WIKI_TOOLS_ENABLED=false)."],
      },
    ];
  }

  return [
    {
      id: "wiki-tools",
      label: "Wikipedia",
      status: "ok",
      details: [`MediaWiki API: ${getWikiBaseUrl()}`],
    },
  ];
}

export function getWikiToolDefinitions(): WikiToolDefinition[] {
  if (!wikiToolsEnabled()) {
    return [];
  }

  return [
    {
      type: "function",
      function: {
        name: "wiki_search",
        description: "Search Wikipedia for matching page titles.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query." },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 20,
              description: "Max results (default 8).",
            },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "wiki_summary",
        description: "Fetch a concise Wikipedia summary for a page title.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "Wikipedia page title." },
          },
          required: ["title"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "wiki_page",
        description: "Fetch a full plaintext Wikipedia page extract.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "Wikipedia page title." },
          },
          required: ["title"],
        },
      },
    },
  ];
}

export async function runWikiTool(name: string, args: WikiToolArguments) {
  if (!wikiToolsEnabled()) {
    throw new Error("Wikipedia tools are disabled.");
  }

  switch (name) {
    case "wiki_search": {
      const query =
        typeof args.query === "string" ? args.query.trim() : "";
      if (!query) {
        throw new Error("wiki_search requires a query.");
      }
      const limitInput =
        typeof args.limit === "number"
          ? args.limit
          : Number(args.limit ?? NaN);
      const limit = Number.isFinite(limitInput)
        ? Math.min(20, Math.max(1, Math.floor(limitInput)))
        : 8;

      const url = buildApiUrl("/w/api.php", {
        action: "query",
        list: "search",
        srsearch: query,
        srlimit: limit,
        format: "json",
        formatversion: 2,
      });
      const data = (await fetchJson(url)) as WikiSearchResponse;
      const results = Array.isArray(data?.query?.search)
        ? data.query.search
        : [];
      return {
        query,
        total_hits:
          typeof data?.query?.searchinfo?.totalhits === "number"
            ? data.query.searchinfo.totalhits
            : results.length,
        results: results.map((entry: WikiSearchEntry) => ({
          title: entry?.title ?? "",
          pageid: entry?.pageid ?? null,
          snippet: stripHtml(entry?.snippet ?? ""),
          url: entry?.title ? buildPageUrl(entry.title) : null,
        })),
      };
    }
    case "wiki_summary": {
      const title =
        typeof args.title === "string" ? args.title.trim() : "";
      if (!title) {
        throw new Error("wiki_summary requires a title.");
      }
      const normalized = normalizeTitle(title);
      const url = new URL(
        `/api/rest_v1/page/summary/${encodeURIComponent(normalized)}`,
        getWikiBaseUrl()
      );
      const response = await fetch(url.toString(), {
        headers: {
          Accept: "application/json",
          "User-Agent": getWikiUserAgent(),
        },
      });
      if (response.status === 404) {
        const payload = await response.json().catch(() => null);
        return {
          title,
          found: false,
          details: payload?.detail || "Page not found.",
        };
      }
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Wikipedia summary failed (${response.status}): ${text}`);
      }
      const data = (await response.json()) as WikiSummaryResponse;
      const resolvedTitle = data?.title || title;
      return {
        title: resolvedTitle,
        summary: data?.extract || "",
        description: data?.description || null,
        url: data?.content_urls?.desktop?.page || buildPageUrl(resolvedTitle),
        found: true,
      };
    }
    case "wiki_page": {
      const title =
        typeof args.title === "string" ? args.title.trim() : "";
      if (!title) {
        throw new Error("wiki_page requires a title.");
      }
      const url = buildApiUrl("/w/api.php", {
        action: "query",
        prop: "extracts",
        explaintext: 1,
        redirects: 1,
        titles: title,
        format: "json",
        formatversion: 2,
      });
      const data = (await fetchJson(url)) as WikiSearchResponse;
      const pages = Array.isArray(data?.query?.pages)
        ? data.query.pages
        : [];
      const page = pages[0];
      if (!page || page.missing) {
        return { title, found: false };
      }
      const resolvedTitle = page?.title || title;
      return {
        title: resolvedTitle,
        pageid: page?.pageid ?? null,
        extract: page?.extract || "",
        url: buildPageUrl(resolvedTitle),
        found: true,
      };
    }
    default:
      throw new Error(`Unknown Wikipedia tool: ${name}`);
  }
}
