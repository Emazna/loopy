import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CodexAppServerClient,
  type ServerNotification,
  type ServerRequest,
} from "@emazna/codex-app-server-adapter";

// 例: LOOP_CANVAS_SMOKE_MODEL=gpt-5.6-sol LOOP_CANVAS_SMOKE_EFFORT=ultra npm run smoke:app-server
const smokeModel = process.env.LOOP_CANVAS_SMOKE_MODEL ?? "gpt-5.4";
const smokeEffort = process.env.LOOP_CANVAS_SMOKE_EFFORT ?? "low";
const smokeWaitMs = Number(process.env.LOOP_CANVAS_SMOKE_WAIT_MS ?? 120_000);

const workspace = await mkdtemp(join(tmpdir(), "emazna-loop-canvas-smoke-"));
const sentinel = "loop-canvas-smoke-verified";
await writeFile(join(workspace, "sentinel.txt"), `${sentinel}\n`, "utf8");

const client = new CodexAppServerClient({ codexHome: process.env.LOOP_CANVAS_CODEX_HOME });
let finalText = "";
const observed = new Set<string>();

client.onNotification((notification: ServerNotification) => {
  observed.add(notification.method);
  if (notification.method === "item/completed") {
    const item = notification.params?.item as Record<string, unknown> | undefined;
    if (item?.type === "agentMessage" && typeof item.text === "string") finalText = item.text;
  }
});
client.onServerRequest((request: ServerRequest) => {
  void client.rejectServerRequest(request.id, -32601, `Smoke test does not support ${request.method}.`);
});
client.onStderr((line) => {
  if (/error|warn/i.test(line)) process.stderr.write(`[app-server] ${line}\n`);
});

try {
  const initialized = await client.start();
  const thread = await client.startThread({
    model: smokeModel,
    cwd: resolve(workspace),
    reasoningEffort: smokeEffort,
    ephemeral: true,
  });
  if (thread.model !== smokeModel) throw new Error(`Effective model drifted to ${thread.model}.`);
  if ((thread.sandbox as { type?: string }).type !== "dangerFullAccess") {
    throw new Error(`Expected dangerFullAccess, got ${JSON.stringify(thread.sandbox)}.`);
  }

  const turn = await client.startTurn({
    threadId: thread.thread.id,
    prompt:
      "Read sentinel.txt from the current working directory. Do not modify any file. Return only JSON with ok=true and observed equal to the exact file content without whitespace.",
    model: smokeModel,
    cwd: resolve(workspace),
    effort: smokeEffort,
    outputSchema: {
      type: "object",
      required: ["ok", "observed"],
      additionalProperties: false,
      properties: {
        ok: { type: "boolean", const: true },
        observed: { type: "string", const: sentinel },
      },
    },
  });
  const completed = await client.waitForTurn(thread.thread.id, turn.turn.id, smokeWaitMs);
  if (completed.turn.status !== "completed") {
    throw new Error(`Turn ended with ${completed.turn.status}: ${JSON.stringify(completed.turn.error)}`);
  }
  const parsed = JSON.parse(finalText) as { ok?: boolean; observed?: string };
  if (parsed.ok !== true || parsed.observed !== sentinel) {
    throw new Error(`Unexpected structured output: ${finalText}`);
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        initialized,
        effective: {
          model: thread.model,
          cwd: thread.cwd,
          approvalPolicy: thread.approvalPolicy,
          sandbox: thread.sandbox,
          cliVersion: thread.thread.cliVersion,
        },
        threadId: thread.thread.id,
        turnId: turn.turn.id,
        final: parsed,
        observedNotifications: [...observed].sort(),
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await client.close();
  await rm(workspace, { recursive: true, force: true });
}
