import { validateWorkflow } from "@emazna/loop-runtime";
import { NextRequest, NextResponse } from "next/server";
import { assertControlRequest } from "../../../lib/security";
import { appStore } from "../../../lib/store";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    assertControlRequest(request);
    const store = appStore();
    const body = (await request.json().catch(() => ({}))) as { workflowId?: string };
    const workflow = store.getWorkflow(typeof body.workflowId === "string" && body.workflowId ? body.workflowId : "default");
    if (!workflow) return NextResponse.json({ error: "対象のワークフローが見つかりません。" }, { status: 404 });
    const issues = validateWorkflow(workflow);
    if (issues.length > 0) return NextResponse.json({ issues }, { status: 400 });
    const run = store.createRun(workflow.id);
    return NextResponse.json({ run: store.getRunSnapshot(run.id) }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 });
  }
}
