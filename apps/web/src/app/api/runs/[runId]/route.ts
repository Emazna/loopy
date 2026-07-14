import { NextRequest, NextResponse } from "next/server";
import { assertLoopback } from "../../../../lib/security";
import { appStore } from "../../../../lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ runId: string }> },
) {
  try {
    assertLoopback(request);
    const { runId } = await context.params;
    const snapshot = appStore().getRunSnapshot(runId);
    if (!snapshot) return NextResponse.json({ error: "Run not found." }, { status: 404 });
    return NextResponse.json({ run: snapshot });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 403 });
  }
}
