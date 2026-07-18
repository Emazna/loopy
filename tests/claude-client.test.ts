import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { TurnCompletedParams } from "@emazna/codex-app-server-adapter";
import { ClaudeCodeClient } from "../apps/runner/src/claude-client";

/**
 * `claude --print` の子プロセスを模したフェイク。stdoutは開いたままにできるので、
 * バックグラウンドの孫プロセス（devサーバー等）がパイプを握っている状況を再現できる。
 */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    pid: number;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 4242;
  return child;
}

function attachTurn(client: ClaudeCodeClient, child: ReturnType<typeof fakeChild>) {
  let resolve!: (terminal: TurnCompletedParams) => void;
  const terminal = new Promise<TurnCompletedParams>((r) => {
    resolve = r;
  });
  const turn = {
    turnId: "turn-1",
    threadId: "thread-1",
    child,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    interruptRequested: false,
    resultText: null,
    resultIsError: false,
    resultErrorMessage: null,
    sawResult: false,
    settled: false,
    resolve,
    terminal,
    toolUses: new Map(),
    stdoutBuffer: "",
  };
  const internals = client as unknown as {
    activeTurn: unknown;
    wireTurnStreams(turn: unknown): void;
  };
  internals.activeTurn = turn;
  internals.wireTurnStreams(turn);
  return { turn, terminal };
}

describe("Claude Code turn completion", () => {
  it("settles on process exit even when a background grandchild keeps stdout open", async () => {
    const client = new ClaudeCodeClient();
    const child = fakeChild();
    const { terminal } = attachTurn(client, child);

    child.stdout.write(`${JSON.stringify({ type: "result", is_error: false, result: "done" })}\n`);
    await new Promise((resolve) => setImmediate(resolve));

    // プロセスは終了するが、孫プロセスがパイプを握っているため "close" は来ない。
    child.emit("exit", 0);

    await expect(terminal).resolves.toMatchObject({ turn: { status: "completed" } });
  });

  it("drains a trailing line written without a newline before settling", async () => {
    const client = new ClaudeCodeClient();
    const child = fakeChild();
    const { terminal } = attachTurn(client, child);

    child.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "tail" }));
    await new Promise((resolve) => setImmediate(resolve));
    child.emit("exit", 0);

    await expect(terminal).resolves.toMatchObject({ turn: { status: "completed" } });
  });

  it("reports a failure when the process exits without a result", async () => {
    const client = new ClaudeCodeClient();
    const child = fakeChild();
    const { terminal } = attachTurn(client, child);

    child.emit("exit", 1);

    const settled = await terminal;
    expect(settled.turn.status).toBe("failed");
    expect(settled.turn.error?.message).toContain("1");
  });

  it("settles once when close follows exit", async () => {
    const client = new ClaudeCodeClient();
    const child = fakeChild();
    const { turn, terminal } = attachTurn(client, child);
    let completions = 0;
    client.onNotification((notification) => {
      if (notification.method === "turn/completed") completions += 1;
    });

    child.stdout.write(`${JSON.stringify({ type: "result", is_error: false, result: "ok" })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    child.emit("close", 0);
    child.emit("exit", 0);

    await expect(terminal).resolves.toMatchObject({ turn: { status: "completed" } });
    expect(completions).toBe(1);
    expect(turn.exitTimer).toBeUndefined();
  });
});
