import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultWorkflow } from "@emazna/loop-runtime";
import { LoopStore } from "@emazna/loop-storage";
import { LoopRunner } from "../apps/runner/src/runtime";

const cleanups: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "loop-runner-controls-"));
  cleanups.push(dir);
  const store = new LoopStore(join(dir, "test.sqlite3"));
  store.ensureWorkflow(createDefaultWorkflow(dir, "gpt-5.4"));
  return { store, runner: new LoopRunner(store) };
}

async function processControls(runner: LoopRunner) {
  await (runner as unknown as { processControls(): Promise<void> }).processControls();
}

describe("runner control state guards", () => {
  it("does not mutate a terminal run when a delayed stop arrives", async () => {
    const { store, runner } = fixture();
    const run = store.createRun();
    store.setRunStatus(run.id, "completed", "test complete");
    store.enqueueControl(run.id, "stop");

    await processControls(runner);

    expect(store.getRun(run.id)?.status).toBe("completed");
    expect(store.listEvents(run.id).some((event) => event.type === "control.failed")).toBe(true);
    store.close();
  });

  it("records Stop before a turn without attempting an interrupt", async () => {
    const { store, runner } = fixture();
    const run = store.createRun();
    store.claimQueuedRun();
    const interrupt = vi.fn();
    const context = {
      runId: run.id,
      threadId: null,
      turnId: null,
      stopRequested: false,
      pauseRequested: false,
      client: { interrupt },
    };
    (runner as unknown as { activeContexts: Map<string, unknown> }).activeContexts.set(run.id, context);
    store.enqueueControl(run.id, "stop");

    await processControls(runner);

    expect(context.stopRequested).toBe(true);
    expect(interrupt).not.toHaveBeenCalled();
    expect(store.getRun(run.id)?.status).toBe("interrupting");
    store.close();
  });

  it("keeps a user-input interaction pending when the App Server reply fails", async () => {
    const { store, runner } = fixture();
    const run = store.createRun();
    const running = store.claimQueuedRun()!;
    const visit = store.startNodeVisit(run.id, running.nextNodeId!, null, "prompt");
    const interaction = store.createPendingInteraction(run.id, visit.id, "request-1", "item/tool/requestUserInput", {});
    (runner as unknown as { activeContexts: Map<string, unknown> }).activeContexts.set(run.id, {
      runId: run.id,
      threadId: "thread-1",
      turnId: "turn-1",
      stopRequested: false,
      pauseRequested: false,
      client: { replyServerRequest: vi.fn().mockRejectedValue(new Error("closed")) },
    });
    store.enqueueControl(run.id, "answer_input", { interactionId: interaction.id, answers: { answer: "yes" } });

    await processControls(runner);

    expect(store.getInteraction(interaction.id)?.status).toBe("pending");
    expect(store.getRun(run.id)?.status).toBe("waiting_input");
    store.close();
  });

  it("preserves the JSON-RPC request id type when answering user input", async () => {
    const { store, runner } = fixture();
    const run = store.createRun();
    const running = store.claimQueuedRun()!;
    const visit = store.startNodeVisit(run.id, running.nextNodeId!, null, "prompt");
    const interaction = store.createPendingInteraction(run.id, visit.id, "42", "item/tool/requestUserInput", {});
    const replyServerRequest = vi.fn().mockResolvedValue(undefined);
    (runner as unknown as { activeContexts: Map<string, unknown> }).activeContexts.set(run.id, {
      runId: run.id,
      threadId: "thread-1",
      turnId: "turn-1",
      stopRequested: false,
      pauseRequested: false,
      client: { replyServerRequest },
    });
    store.enqueueControl(run.id, "answer_input", { interactionId: interaction.id, answers: { answer: "yes" } });

    await processControls(runner);

    expect(replyServerRequest).toHaveBeenCalledWith(42, { answers: { answer: "yes" } });
    expect(store.getInteraction(interaction.id)?.status).toBe("answered");
    store.close();
  });

  it("force-closes the App Server when an acknowledged Stop never completes", async () => {
    vi.useFakeTimers();
    const { store, runner } = fixture();
    const run = store.createRun();
    const running = store.claimQueuedRun()!;
    const visit = store.startNodeVisit(run.id, running.nextNodeId!, null, "prompt");
    store.attachTurn(visit.id, "turn-1", "session-1");
    const close = vi.fn().mockResolvedValue(undefined);
    (runner as unknown as { activeContexts: Map<string, unknown> }).activeContexts.set(run.id, {
      runId: run.id,
      threadId: "thread-1",
      turnId: "turn-1",
      stopRequested: false,
      pauseRequested: false,
      transportLost: false,
      client: { interrupt: vi.fn().mockResolvedValue(undefined), close },
    });
    store.enqueueControl(run.id, "stop");

    await processControls(runner);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(close).toHaveBeenCalledOnce();
    store.close();
  });

  it("closes the transport when Stop arrives during turn/start", async () => {
    const { store, runner } = fixture();
    const run = store.createRun();
    const running = store.claimQueuedRun()!;
    store.startNodeVisit(run.id, running.nextNodeId!, null, "prompt");
    const close = vi.fn().mockResolvedValue(undefined);
    const context = {
      runId: run.id,
      threadId: "thread-1",
      turnId: null,
      turnStartInFlight: true,
      stopRequested: false,
      pauseRequested: false,
      transportLost: false,
      client: { interrupt: vi.fn(), close },
    };
    (runner as unknown as { activeContexts: Map<string, unknown> }).activeContexts.set(run.id, context);
    store.enqueueControl(run.id, "stop");

    await processControls(runner);

    expect(context.stopRequested).toBe(true);
    expect(context.transportLost).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    store.close();
  });

  it("preserves a clean paused run during runner shutdown", async () => {
    const { store, runner } = fixture();
    const run = store.createRun();
    store.setRunStatus(run.id, "paused", "test pause");
    (runner as unknown as { activeContexts: Map<string, unknown> }).activeContexts.set(run.id, {
      runId: run.id,
      threadId: null,
      turnId: null,
      client: { close: vi.fn().mockResolvedValue(undefined) },
    });

    await runner.stop();

    expect(store.getRun(run.id)?.status).toBe("paused");
    store.close();
  });
});
