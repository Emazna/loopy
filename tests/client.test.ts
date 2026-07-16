import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "@emazna/codex-app-server-adapter";

function inject(client: CodexAppServerClient, message: Record<string, unknown>): void {
  (client as unknown as { handleLine: (line: string) => void }).handleLine(JSON.stringify(message));
}

describe("Codex App Server client lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects an outstanding turn waiter when the client closes", async () => {
    const client = new CodexAppServerClient();
    const waiter = client.waitForTurn("thread", "turn", 60_000);
    const rejection = expect(waiter).rejects.toThrow("client closed");

    await client.close();

    await rejection;
  });

  it("cuts a turn only after the inactivity window elapses with no events", async () => {
    vi.useFakeTimers();
    const client = new CodexAppServerClient();
    const waiter = client.waitForTurn("thread", "turn", 60_000);
    const rejection = expect(waiter).rejects.toThrow("応答が1分間途絶えた");

    await vi.advanceTimersByTimeAsync(60_000);

    await rejection;
  });

  it("keeps waiting while thread events flow, then resolves on turn/completed", async () => {
    vi.useFakeTimers();
    const client = new CodexAppServerClient();
    const waiter = client.waitForTurn("thread", "turn", 60_000);
    let settled = false;
    void waiter.finally(() => {
      settled = true;
    });

    // 50秒ごとにイベントが届く限り、60秒の無活動タイムアウトには達しない。
    for (let i = 0; i < 3; i += 1) {
      await vi.advanceTimersByTimeAsync(50_000);
      inject(client, { method: "item/agentMessage/delta", params: { threadId: "thread", turnId: "turn", delta: "…" } });
    }
    expect(settled).toBe(false);

    inject(client, {
      method: "turn/completed",
      params: { threadId: "thread", turn: { id: "turn", status: "completed", error: null, durationMs: 150_000 } },
    });
    await expect(waiter).resolves.toMatchObject({ turn: { status: "completed" } });
  });

  it("does not extend the window for events from other threads", async () => {
    vi.useFakeTimers();
    const client = new CodexAppServerClient();
    const waiter = client.waitForTurn("thread", "turn", 60_000);
    const rejection = expect(waiter).rejects.toThrow("途絶えた");

    await vi.advanceTimersByTimeAsync(50_000);
    inject(client, { method: "item/agentMessage/delta", params: { threadId: "other-thread", delta: "…" } });
    await vi.advanceTimersByTimeAsync(10_000);

    await rejection;
  });
});
