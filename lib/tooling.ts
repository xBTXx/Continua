export type ToolCategory =
  | "communication"
  | "web"
  | "filesystem"
  | "academic"
  | "scheduling"
  | "navigation"
  | "system";

export type ToolConfidence = "high" | "medium" | "low";

type ToolManifestItem = {
  id: ToolCategory;
  description: string;
  examples: string[];
};

const TOOL_CATEGORY_MANIFEST: ToolManifestItem[] = [
  {
    id: "communication",
    description: "Email tasks: list, read, draft, reply, send messages.",
    examples: ["check email", "reply to the latest email", "draft an email"],
  },
  {
    id: "web",
    description: "Live web info via Crawl4AI or Wikipedia lookups.",
    examples: ["research a website", "crawl a URL", "Wikipedia summary"],
  },
  {
    id: "filesystem",
    description: "Workspace files: read/write markdown, text, and CSV.",
    examples: ["read notes.md", "update roadmap.md", "summarize data.csv"],
  },
  {
    id: "academic",
    description: "arXiv papers: search and fetch academic preprints.",
    examples: ["find arXiv papers on transformers", "fetch arXiv:2401.12345"],
  },
  {
    id: "scheduling",
    description: "Calendar events, reminders, and scheduling.",
    examples: ["add a meeting", "list my calendar", "set a reminder"],
  },
  {
    id: "navigation",
    description: "Google Maps: distances, routes, travel times, and directions.",
    examples: ["distance from Berlin to Milan", "how long to drive to Warsaw", "route via Innsbruck"],
  },
  {
    id: "system",
    description: "Source-code and environment file access via doc tools.",
    examples: ["open app/api/chat/route.ts", "read README.md"],
  },
];

const TOOL_CATEGORY_SET = new Set<ToolCategory>(
  TOOL_CATEGORY_MANIFEST.map((item) => item.id)
);

const TOOL_CATEGORY_ALIASES: Record<string, ToolCategory> = {
  communication: "communication",
  email: "communication",
  mail: "communication",
  inbox: "communication",
  web: "web",
  wikipedia: "web",
  wiki: "web",
  crawl4ai: "web",
  internet: "web",
  websearch: "web",
  filesystem: "filesystem",
  file: "filesystem",
  files: "filesystem",
  docs: "filesystem",
  documents: "filesystem",
  csv: "filesystem",
  scheduling: "scheduling",
  calendar: "scheduling",
  schedule: "scheduling",
  event: "scheduling",
  academic: "academic",
  arxiv: "academic",
  paper: "academic",
  papers: "academic",
  system: "system",
  code: "system",
  repo: "system",
  repository: "system",
  navigation: "navigation",
  maps: "navigation",
  directions: "navigation",
  route: "navigation",
  distance: "navigation",
  driving: "navigation",
};

const TOOL_CONFIDENCE_SET = new Set<ToolConfidence>([
  "high",
  "medium",
  "low",
]);

const TOOL_CATEGORY_REGEXES: Array<{ category: ToolCategory; regex: RegExp }> = [
  {
    category: "communication",
    regex: /\b(email|emails|inbox|mailbox|outlook|imap|smtp)\b/i,
  },
  {
    category: "web",
    regex:
      /\b(wikipedia|wiki|crawl4ai|crawl|scrape|website|web search|webpage)\b|https?:\/\/|www\./i,
  },
  {
    category: "filesystem",
    regex:
      /\b(file|files|folder|directory|workspace|markdown|csv|spreadsheet)\b|\.(md|csv|txt)\b/i,
  },
  {
    category: "academic",
    regex: /\b(arxiv|preprint|paper|papers)\b/i,
  },
  {
    category: "scheduling",
    regex: /\b(calendar|schedule|meeting|appointment|reminder|event)\b/i,
  },
  {
    category: "navigation",
    regex:
      /\b(distance|route|directions|how far|driving time|travel time|maps|navigate|kilometers|km|miles|highway|toll)\b|\bfrom\s+\w+\s+to\s+\w+\b/i,
  },
  {
    category: "system",
    regex:
      /\b(source code|codebase|repo|repository|readme)\b|(?:^|\s)(app|lib|components|config|docs|mcp|scripts)\/|\b[\w.-]+\.(ts|tsx|js|json|yml|yaml)\b/i,
  },
];

export function getToolCategoryManifest(): ToolManifestItem[] {
  return TOOL_CATEGORY_MANIFEST;
}

export function getToolCategoryPromptBlock(): string {
  return TOOL_CATEGORY_MANIFEST.map((item) => {
    const examples = item.examples.length > 0 ? ` e.g., ${item.examples.join("; ")}` : "";
    return `- ${item.id}: ${item.description}${examples}`;
  }).join("\n");
}

export function normalizeToolConfidence(value: unknown): ToolConfidence | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase() as ToolConfidence;
  return TOOL_CONFIDENCE_SET.has(normalized) ? normalized : undefined;
}

export function normalizeToolCategories(value: unknown): ToolCategory[] {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? [value]
      : [];
  const resolved: ToolCategory[] = [];

  rawValues.forEach((entry) => {
    if (typeof entry !== "string") {
      return;
    }
    const cleaned = entry.trim().toLowerCase();
    if (!cleaned) {
      return;
    }
    if (TOOL_CATEGORY_SET.has(cleaned as ToolCategory)) {
      resolved.push(cleaned as ToolCategory);
      return;
    }
    const normalizedKey = cleaned.replace(/[^a-z]/g, "");
    const alias = TOOL_CATEGORY_ALIASES[normalizedKey];
    if (alias) {
      resolved.push(alias);
    }
  });

  return Array.from(new Set(resolved));
}

export function inferToolCategoriesFromText(text: string): ToolCategory[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  const matches: ToolCategory[] = [];
  TOOL_CATEGORY_REGEXES.forEach(({ category, regex }) => {
    if (regex.test(trimmed)) {
      matches.push(category);
    }
  });
  return Array.from(new Set(matches));
}
