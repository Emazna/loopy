import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerNotification } from "@emazna/codex-app-server-adapter";
import { ClaudeCodeClient } from "../apps/runner/src/claude-client.js";

const cwd = await mkdtemp(join(tmpdir(), "loopy-claude-smoke-"));
const client = new ClaudeCodeClient();
const events: ServerNotification[] = [];
client.onNotification((notification) => events.push(notification));
client.onStderr((line) => console.error("[stderr]", line.slice(0, 200)));

try {
  const init = await client.start();
  console.log("version:", init.userAgent);

  const model = "claude-haiku-4-5-20251001";
  const thread = await client.startThread({ model, cwd, reasoningEffort: "low" });
  console.log("thread:", thread.thread.id, "sandbox:", JSON.stringify(thread.sandbox));

  // ターン1: 新規セッション（--session-id）
  const turn1 = await client.startTurn({
    threadId: thread.thread.id,
    prompt: "1+1の答えだけを数字1文字で返してください。ツールは使わないでください。",
    model,
    cwd,
    effort: "low",
  });
  const terminal1 = await client.waitForTurn(thread.thread.id, turn1.turn.id, 120_000);
  const message1 = events.filter((e) => e.method === "item/completed").at(-1)?.params?.item as { text?: string };
  console.log("turn1:", terminal1.turn.status, "answer:", JSON.stringify(message1?.text));

  // ターン2: セッション継続（--resume）＋ 構造化出力（分岐の回答形式）
  const turn2 = await client.startTurn({
    threadId: thread.thread.id,
    prompt: "この会話で直前にあなたが答えた数字に10を足した値を choice として返してください。",
    model,
    cwd,
    effort: "low",
    outputSchema: {
      type: "object",
      required: ["choice"],
      additionalProperties: false,
      properties: { choice: { type: "string", enum: ["11", "12", "13"] } },
    },
  });
  const terminal2 = await client.waitForTurn(thread.thread.id, turn2.turn.id, 120_000);
  const message2 = events.filter((e) => e.method === "item/completed").at(-1)?.params?.item as { text?: string };
  console.log("turn2:", terminal2.turn.status, "structured:", JSON.stringify(message2?.text));

  const commandEvents = events.filter((e) => e.method === "item/started").length;
  console.log("commandEvents:", commandEvents, "totalEvents:", events.length);

  const ok =
    terminal1.turn.status === "completed" &&
    terminal2.turn.status === "completed" &&
    (message1?.text ?? "").includes("2") &&
    (message2?.text ?? "").includes("12");
  console.log(ok ? "SMOKE OK" : "SMOKE FAILED");
  process.exitCode = ok ? 0 : 1;
} finally {
  await client.close();
  await rm(cwd, { recursive: true, force: true });
}
