import { NextRequest, NextResponse } from "next/server";
import { assertControlRequest } from "../../../../lib/security";
import { appStore } from "../../../../lib/store";

export const runtime = "nodejs";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ workflowId: string }> },
) {
  try {
    assertControlRequest(request);
    const store = appStore();
    const { workflowId } = await params;
    if (store.listWorkflows().length <= 1) {
      return NextResponse.json({ error: "最後のワークフローは削除できません。" }, { status: 409 });
    }
    if (!store.getWorkflow(workflowId)) {
      return NextResponse.json({ error: "対象のワークフローが見つかりません。" }, { status: 404 });
    }
    store.deleteWorkflow(workflowId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 });
  }
}
