import { NextRequest } from "next/server";
import { assertLoopback } from "../../../../../lib/security";
import { appStore } from "../../../../../lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ runId: string }> },
) {
  try {
    assertLoopback(request);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 403 });
  }
  const { runId } = await context.params;
  const store = appStore();
  if (!store.getRun(runId)) return Response.json({ error: "Run not found." }, { status: 404 });

  const headerCursor = Number(request.headers.get("last-event-id") ?? "0");
  const queryCursor = Number(request.nextUrl.searchParams.get("after") ?? "0");
  let cursor = Number.isFinite(headerCursor) && headerCursor > 0 ? headerCursor : queryCursor;
  if (!Number.isFinite(cursor)) cursor = 0;
  const encoder = new TextEncoder();
  let timer: NodeJS.Timeout | null = null;
  let heartbeatAt = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = () => {
        try {
          const events = store.listEvents(runId, cursor, 200);
          for (const event of events) {
            cursor = event.seq;
            controller.enqueue(
              encoder.encode(`id: ${event.seq}\nevent: run-event\ndata: ${JSON.stringify(event)}\n\n`),
            );
          }
          if (Date.now() - heartbeatAt > 10_000) {
            controller.enqueue(encoder.encode(`: heartbeat ${new Date().toISOString()}\n\n`));
            heartbeatAt = Date.now();
          }
        } catch (error) {
          controller.error(error);
          if (timer) clearInterval(timer);
        }
      };
      send();
      timer = setInterval(send, 350);
      request.signal.addEventListener(
        "abort",
        () => {
          if (timer) clearInterval(timer);
          try {
            controller.close();
          } catch {
            // Already closed by the runtime.
          }
        },
        { once: true },
      );
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
