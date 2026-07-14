import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunSnapshot, WorkflowDefinition } from "@emazna/loop-runtime";
import { LoopStore } from "@emazna/loop-storage";
import { LoopRunner } from "../apps/runner/src/runtime.js";

const root = await mkdtemp(join(tmpdir(), "emazna-loop-controls-smoke-"));
const store = new LoopStore(join(root, "controls.sqlite3"));
const workflow: WorkflowDefinition = {
  id: "default",
  name: "Pause and interrupt smoke",
  model: "gpt-5.4",
  cwd: root,
  approvalPolicy: "never",
  sandboxMode: "danger-full-access",
  reasoningEffort: "low",
  initialState: {},
  limits: { maxNodeVisits: 6, maxVisitsPerNode: 2, maxRunMinutes: 10, turnTimeoutMinutes: 2 },
  updatedAt: new Date().toISOString(),
  nodes: [
    { id: "start", kind: "start", title: "Start", summary: "start", position: { x: 0, y: 0 } },
    {
      id: "first",
      kind: "agent",
      title: "Pause boundary",
      summary: "slow first node",
      position: { x: 200, y: 0 },
      sessionPolicy: "fresh",
      outputKey: "first",
      prompt:
        "Use the shell tool once to run exactly: pwsh -NoProfile -Command \"Start-Sleep -Seconds 5\". After it finishes, reply with exactly alpha. Do not modify files.",
    },
    {
      id: "second",
      kind: "agent",
      title: "Interrupt target",
      summary: "long second node",
      position: { x: 500, y: 0 },
      sessionPolicy: "continue",
      outputKey: "second",
      prompt:
        "Use the shell tool once to run exactly: pwsh -NoProfile -Command \"Start-Sleep -Seconds 30\". After it finishes, reply with exactly beta. Do not modify files.",
    },
    { id: "end", kind: "end", title: "End", summary: "done", position: { x: 800, y: 0 } },
  ],
  edges: [
    { id: "e1", source: "start", target: "first", label: "start" },
    { id: "e2", source: "first", target: "second", label: "next" },
    { id: "e3", source: "second", target: "end", label: "done" },
  ],
};

async function waitFor(
  predicate: (snapshot: RunSnapshot) => boolean,
  runId: string,
  timeoutMs: number,
): Promise<RunSnapshot> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = store.getRunSnapshot(runId)!;
    if (predicate(snapshot)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const snapshot = store.getRunSnapshot(runId)!;
  throw new Error(`Timed out in ${snapshot.run.status}; next=${snapshot.run.nextNodeId}.`);
}

store.saveWorkflow(workflow);
const run = store.createRun();
const runner = new LoopRunner(store);
runner.start();

try {
  await waitFor(
    (snapshot) => snapshot.visits.some((visit) => visit.nodeId === "first" && Boolean(visit.codexTurnId)),
    run.id,
    60_000,
  );
  store.enqueueControl(run.id, "pause");
  const paused = await waitFor((snapshot) => snapshot.run.status === "paused", run.id, 90_000);
  if (paused.run.nextNodeId !== "second") throw new Error(`Pause cursor drifted to ${paused.run.nextNodeId}.`);
  if (paused.visits.some((visit) => visit.nodeId === "second")) {
    throw new Error("Second node started after pause was accepted.");
  }

  store.enqueueControl(run.id, "resume");
  await waitFor(
    (snapshot) => snapshot.visits.some((visit) => visit.nodeId === "second" && Boolean(visit.codexTurnId)),
    run.id,
    60_000,
  );
  store.enqueueControl(run.id, "interrupt");
  const interrupted = await waitFor(
    (snapshot) => snapshot.run.status === "recovery_required",
    run.id,
    90_000,
  );
  const second = interrupted.visits.find((visit) => visit.nodeId === "second");
  if (!second || !["interrupted", "outcome_unknown"].includes(second.status)) {
    throw new Error(`Unexpected interrupted visit status: ${second?.status ?? "missing"}.`);
  }
  if (interrupted.run.nextNodeId !== "second") {
    throw new Error("Interrupted node was not preserved as the recovery cursor.");
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        pause: {
          status: paused.run.status,
          nextNodeId: paused.run.nextNodeId,
          visits: paused.visits.map((visit) => visit.nodeId),
        },
        interrupt: {
          status: interrupted.run.status,
          nextNodeId: interrupted.run.nextNodeId,
          visitStatus: second.status,
          terminationReason: interrupted.run.terminationReason,
        },
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await runner.stop();
  store.close();
  await rm(root, { recursive: true, force: true });
}
