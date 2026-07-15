import { validateWorkflow } from "@emazna/loop-runtime";
import { NextRequest, NextResponse } from "next/server";
import { CONTROL_COOKIE, assertLoopback } from "../../../lib/security";
import { appStore } from "../../../lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    assertLoopback(request);
    const store = appStore();
    const workflows = store.listWorkflows();
    const requestedId = request.nextUrl.searchParams.get("workflow");
    const workflowId = requestedId && workflows.some((w) => w.id === requestedId)
      ? requestedId
      : workflows[0]!.id;
    const workflow = store.getWorkflow(workflowId)!;
    const latest = store.getLatestRunForWorkflow(workflowId);
    const runnerHeartbeat = store.getMeta("runner_heartbeat");
    const heartbeatAt = runnerHeartbeat ? Date.parse(runnerHeartbeat) : Number.NaN;
    const runnerIsLive = Number.isFinite(heartbeatAt) && Date.now() - heartbeatAt < 5_000;
    const response = NextResponse.json({
      workflow,
      workflows,
      latestRun: latest ? store.getRunSnapshot(latest.id) : null,
      validationIssues: validateWorkflow(workflow),
      health: {
        runnerStatus: runnerIsLive ? store.getMeta("runner_status") ?? "online" : "offline",
        runnerHeartbeat,
        codexStatus: runnerIsLive ? store.getMeta("codex_status") ?? "disconnected" : "disconnected",
        codexHome: store.getMeta("codex_home"),
      },
    });
    response.cookies.set(CONTROL_COOKIE, store.getOrCreateControlToken(), {
      httpOnly: true,
      sameSite: "strict",
      secure: false,
      path: "/",
      maxAge: 60 * 60 * 12,
    });
    return response;
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 403 });
  }
}
