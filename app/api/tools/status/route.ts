import { getEmailToolStatus } from "@/lib/emailTools";
import { getCrawl4AIToolStatus } from "@/lib/crawl4aiTools";
import { getPersonalMemoryToolStatus } from "@/lib/personalMemoryTools";
import { getWikiToolStatus } from "@/lib/wikiTools";
import { getCalendarToolStatus } from "@/lib/calendarTools";
import { getCsvToolStatus, getDocToolStatus } from "@/lib/fileTools";
import { getArxivToolStatus } from "@/lib/arxivTools";
import { getMapsToolStatus } from "@/lib/mapsTools";
import { getUserToolStatus } from "@/lib/userTools";
import { getWebSessionStats } from "@/lib/webSessions";
import { getWebArtifactsStats } from "@/lib/webArtifacts";
import { getSSEFToolStatus } from "@/lib/ssef";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [
      email,
      wiki,
      crawl4ai,
      personal,
      arxiv,
      userAdmin,
      webSessions,
      webArtifacts,
      ssef,
    ] = await Promise.all([
      getEmailToolStatus(),
      getWikiToolStatus(),
      getCrawl4AIToolStatus(),
      getPersonalMemoryToolStatus(),
      getArxivToolStatus(),
      getUserToolStatus(),
      getWebSessionStats(),
      getWebArtifactsStats(),
      getSSEFToolStatus(),
    ]);
    const calendar = getCalendarToolStatus();
    const docs = getDocToolStatus();
    const csv = getCsvToolStatus();
    const maps = getMapsToolStatus();
    return Response.json({
      email,
      wiki,
      crawl4ai,
      personal,
      arxiv,
      userAdmin,
      calendar,
      docs,
      csv,
      maps,
      webSessions,
      webArtifacts,
      ssef,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to read tool status";
    return new Response(message, { status: 500 });
  }
}
