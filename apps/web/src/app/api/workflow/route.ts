import { existsSync, realpathSync, statSync } from "node:fs";
import { validateWorkflow, type WorkflowDefinition } from "@emazna/loop-runtime";
import { NextRequest, NextResponse } from "next/server";
import { assertControlRequest } from "../../../lib/security";
import { appStore } from "../../../lib/store";

export const runtime = "nodejs";

export async function PUT(request: NextRequest) {
  try {
    assertControlRequest(request);
    const submitted = (await request.json()) as WorkflowDefinition;
    if (!submitted || typeof submitted.cwd !== "string" || !existsSync(submitted.cwd)) {
      return NextResponse.json({ issues: [{ code: "invalid_cwd", message: "Working directory must exist." }] }, { status: 400 });
    }
    const cwd = realpathSync.native(submitted.cwd);
    if (!statSync(cwd).isDirectory()) {
      return NextResponse.json({ issues: [{ code: "invalid_cwd", message: "Working directory must be a directory." }] }, { status: 400 });
    }
    const workflow: WorkflowDefinition = {
      ...submitted,
      id: "default",
      approvalPolicy: "never",
      sandboxMode: "danger-full-access",
      cwd,
      updatedAt: new Date().toISOString(),
    };
    const issues = validateWorkflow(workflow);
    if (issues.length > 0) return NextResponse.json({ issues }, { status: 400 });
    return NextResponse.json({ workflow: appStore().saveWorkflow(workflow), issues: [] });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 403 });
  }
}
