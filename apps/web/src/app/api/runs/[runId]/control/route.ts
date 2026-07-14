import { type ControlAction, type JsonValue } from "@emazna/loop-runtime";
import { NextRequest, NextResponse } from "next/server";
import { assertControlRequest } from "../../../../../lib/security";
import { appStore } from "../../../../../lib/store";

export const runtime = "nodejs";

const ACTIONS = new Set<ControlAction>([
  "pause",
  "resume",
  "interrupt",
  "stop",
  "retry",
  "skip",
  "answer_input",
]);

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ runId: string }> },
) {
  try {
    assertControlRequest(request);
    const { runId } = await context.params;
    const body = (await request.json()) as { action?: ControlAction; payload?: JsonValue };
    if (!body.action || !ACTIONS.has(body.action)) {
      return NextResponse.json({ error: "Unknown control action." }, { status: 400 });
    }
    const store = appStore();
    if (!store.getRun(runId)) return NextResponse.json({ error: "Run not found." }, { status: 404 });
    const commandId = store.enqueueControl(runId, body.action, body.payload ?? {});
    return NextResponse.json({ commandId });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 403 });
  }
}
