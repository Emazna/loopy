import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultWorkflow } from "@emazna/loop-runtime";
import { LoopStore } from "@emazna/loop-storage";

const cleanups: string[] = [];

afterEach(() => {
  for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("LoopStore", () => {
  it("creates immutable run versions and durable event sequences", () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-store-"));
    cleanups.push(dir);
    const store = new LoopStore(join(dir, "test.sqlite3"));
    store.ensureWorkflow(createDefaultWorkflow(dir, "gpt-5.4"));
    const run = store.createRun();
    const one = store.appendEvent(run.id, "test.one", { ok: true });
    const two = store.appendEvent(run.id, "test.two", { ok: true });
    expect(one.seq).toBeGreaterThan(0);
    expect(two.seq).toBe(one.seq + 1);
    expect(store.getRunSnapshot(run.id)?.definition.model).toBe("gpt-5.4");
    store.close();
  });

  it("does not allow two active runs to lease the same cwd", () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-store-"));
    cleanups.push(dir);
    const store = new LoopStore(join(dir, "test.sqlite3"));
    store.ensureWorkflow(createDefaultWorkflow(dir, "gpt-5.4"));
    store.createRun();
    expect(() => store.createRun()).toThrow(/already leased/);
    store.close();
  });

  it("recovers an abandoned visit with a retryable node cursor", () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-store-"));
    cleanups.push(dir);
    const store = new LoopStore(join(dir, "test.sqlite3"));
    store.ensureWorkflow(createDefaultWorkflow(dir, "gpt-5.4"));
    const queued = store.createRun();
    const running = store.claimQueuedRun()!;
    const nodeId = running.nextNodeId!;
    const visit = store.startNodeVisit(queued.id, nodeId, null, "prompt");
    const interaction = store.createPendingInteraction(queued.id, visit.id, "request-1", "item/tool/requestUserInput", {});

    expect(store.recoverAbandonedRuns()).toBe(1);
    const recovered = store.getRun(queued.id)!;
    expect(recovered).toMatchObject({ status: "recovery_required", nextNodeId: nodeId, currentNodeVisitId: null });
    expect(store.getVisit(visit.id)?.status).toBe("outcome_unknown");
    expect(store.getInteraction(interaction.id)?.status).toBe("connection_lost");

    const retried = store.requeueRecoveryRun(queued.id);
    expect(retried).toMatchObject({ status: "queued", nextNodeId: nodeId, currentNodeVisitId: null });
    store.close();
  });

  it("requeues safe processing controls after a runner restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-store-"));
    cleanups.push(dir);
    const store = new LoopStore(join(dir, "test.sqlite3"));
    store.ensureWorkflow(createDefaultWorkflow(dir, "gpt-5.4"));
    const run = store.createRun();
    const commandId = store.enqueueControl(run.id, "stop");
    expect(store.takePendingCommands()).toHaveLength(1);

    expect(store.recoverProcessingCommands()).toBe(1);
    expect(store.takePendingCommands()).toContainEqual(expect.objectContaining({ id: commandId, type: "stop" }));
    store.close();
  });

  it("returns the most recent 500 events in snapshots", () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-store-"));
    cleanups.push(dir);
    const store = new LoopStore(join(dir, "test.sqlite3"));
    store.ensureWorkflow(createDefaultWorkflow(dir, "gpt-5.4"));
    const run = store.createRun();
    for (let index = 0; index < 510; index += 1) {
      store.appendEvent(run.id, "test.event", { index });
    }

    const events = store.getRunSnapshot(run.id)!.events;
    expect(events).toHaveLength(500);
    expect(events[0]!.seq).toBe(12);
    expect(events.at(-1)!.seq).toBe(511);
    store.close();
  });
});
