import { useState, useEffect, useCallback, useMemo } from "react";
import { withBasePath } from "@/lib/basePath";

export type ToolStatus = {
  id: string;
  label: string;
  status: "ok" | "error";
  details: string[];
};

export function useTools(webSearchEnabled: boolean) {
  const [toolStatus, setToolStatus] = useState<ToolStatus[]>([]);
  const [toolStatusLoading, setToolStatusLoading] = useState(false);
  const [toolStatusError, setToolStatusError] = useState<string | null>(null);
  const [toolDebugEnabled, setToolDebugEnabled] = useState(false);
  const [toolDebugLoading, setToolDebugLoading] = useState(false);
  const [toolDebugError, setToolDebugError] = useState<string | null>(null);
  const [toolDebugData, setToolDebugData] = useState<unknown>(null);

  const fetchToolStatus = useCallback(async () => {
    setToolStatusLoading(true);
    setToolStatusError(null);
    try {
      const response = await fetch(withBasePath("/api/tools/status"));
      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || "Unable to load tool status.");
      }
      const data = (await response.json()) as {
        email?: ToolStatus[];
        wiki?: ToolStatus[];
        crawl4ai?: ToolStatus[];
        personal?: ToolStatus[];
        calendar?: ToolStatus[];
        docs?: ToolStatus[];
        csv?: ToolStatus[];
        arxiv?: ToolStatus[];
        system?: ToolStatus[];
        userAdmin?: ToolStatus[];
      };
      const email = Array.isArray(data.email) ? data.email : [];
      const wiki = Array.isArray(data.wiki) ? data.wiki : [];
      const crawl4ai = Array.isArray(data.crawl4ai) ? data.crawl4ai : [];
      const personal = Array.isArray(data.personal) ? data.personal : [];
      const calendar = Array.isArray(data.calendar) ? data.calendar : [];
      const docs = Array.isArray(data.docs) ? data.docs : [];
      const csv = Array.isArray(data.csv) ? data.csv : [];
      const arxiv = Array.isArray(data.arxiv) ? data.arxiv : [];
      const system = Array.isArray(data.system) ? data.system : [];
      const userAdmin = Array.isArray(data.userAdmin) ? data.userAdmin : [];
      setToolStatus([
        ...email,
        ...wiki,
        ...crawl4ai,
        ...personal,
        ...calendar,
        ...docs,
        ...csv,
        ...arxiv,
        ...system,
        ...userAdmin,
      ]);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to load tool status.";
      setToolStatusError(message);
      setToolStatus([]);
    } finally {
      setToolStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchToolStatus();
  }, [fetchToolStatus]);

  const refreshToolDebug = useCallback(async () => {
    if (!toolDebugEnabled) {
      setToolDebugData(null);
      setToolDebugError(null);
      return;
    }
    setToolDebugLoading(true);
    setToolDebugError(null);
    try {
      const response = await fetch(withBasePath("/api/tools/last"));
      if (response.status === 204) {
        setToolDebugData(null);
        return;
      }
      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || "Unable to load tool debug data.");
      }
      const data = await response.json();
      if (data && typeof data === "object" && "data" in data) {
        setToolDebugData((data as { data?: unknown }).data ?? null);
      } else {
        setToolDebugData(data);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to load tool debug data.";
      setToolDebugError(message);
      setToolDebugData(null);
    } finally {
      setToolDebugLoading(false);
    }
  }, [toolDebugEnabled]);

  const toolboxTools = useMemo<ToolStatus[]>(
    () => [
      {
        id: "web-search",
        label: "Web search",
        status: webSearchEnabled ? "ok" : "error",
        details: [
          webSearchEnabled
            ? "Enabled via OpenRouter web plugin."
            : "Disabled in settings.",
        ],
      },
      ...toolStatus,
    ],
    [toolStatus, webSearchEnabled]
  );

  return {
    toolStatus: toolboxTools,
    toolStatusLoading,
    toolStatusError,
    fetchToolStatus,
    toolDebugEnabled,
    setToolDebugEnabled,
    toolDebugLoading,
    toolDebugError,
    toolDebugData,
    refreshToolDebug,
    setToolDebugData,
    setToolDebugError,
  };
}
