export type ToolDebugSnapshot = {
  data: unknown;
  updatedAt: string;
};

declare global {
  var __toolDebugSnapshot: ToolDebugSnapshot | undefined;
}

export function setLastToolDebug(data: unknown) {
  globalThis.__toolDebugSnapshot = {
    data,
    updatedAt: new Date().toISOString(),
  };
}

export async function GET() {
  const snapshot = globalThis.__toolDebugSnapshot;
  if (!snapshot) {
    return new Response(null, { status: 204 });
  }
  return Response.json(snapshot);
}
