import { randomUUID } from "node:crypto";
import { createDefaultWorkflow } from "@emazna/loop-runtime";
import { NextRequest, NextResponse } from "next/server";
import { assertControlRequest } from "../../../lib/security";
import { appStore } from "../../../lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    assertControlRequest(request);
    return NextResponse.json({ workflows: appStore().listWorkflows() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 403 });
  }
}

/** 新規ワークフロー作成。sourceIdを渡すと複製、無ければ空のテンプレートから作る。 */
export async function POST(request: NextRequest) {
  try {
    assertControlRequest(request);
    const store = appStore();
    const body = (await request.json().catch(() => ({}))) as { name?: string; sourceId?: string };

    const id = randomUUID();
    let definition;
    if (typeof body.sourceId === "string" && body.sourceId) {
      const source = store.getWorkflow(body.sourceId);
      if (!source) return NextResponse.json({ error: "複製元のワークフローが見つかりません。" }, { status: 404 });
      definition = { ...source, id, name: body.name?.trim() || `${source.name}のコピー` };
    } else {
      const base = store.listWorkflows()[0];
      const template = base ? store.getWorkflow(base.id) : null;
      const cwd = template?.cwd ?? process.env.LOOP_CANVAS_WORKDIR ?? process.cwd();
      const model = template?.model ?? process.env.LOOP_CANVAS_MODEL ?? "gpt-5.4";
      definition = { ...createDefaultWorkflow(cwd, model), id, name: body.name?.trim() || "新しいワークフロー" };
      if (template?.engine) definition.engine = template.engine;
    }
    return NextResponse.json({ workflow: store.saveWorkflow(definition) }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 });
  }
}
