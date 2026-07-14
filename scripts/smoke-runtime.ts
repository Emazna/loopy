import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowDefinition } from "@emazna/loop-runtime";
import { LoopStore } from "@emazna/loop-storage";
import { LoopRunner } from "../apps/runner/src/runtime.js";

const root = await mkdtemp(join(tmpdir(), "emazna-loop-runtime-smoke-"));
const store = new LoopStore(join(root, "runtime.sqlite3"));
const now = new Date().toISOString();
const workflow: WorkflowDefinition = {
  id: "default",
  name: "Session lineage smoke",
  model: "gpt-5.4",
  cwd: root,
  approvalPolicy: "never",
  sandboxMode: "danger-full-access",
  reasoningEffort: "low",
  initialState: { task: "Protocol-only smoke. Do not modify files." },
  limits: { maxNodeVisits: 10, maxVisitsPerNode: 2, maxRunMinutes: 10, turnTimeoutMinutes: 2 },
  updatedAt: now,
  nodes: [
    { id: "start", kind: "start", title: "Start", summary: "start", position: { x: 0, y: 0 } },
    {
      id: "first",
      kind: "agent",
      title: "First",
      summary: "fresh",
      position: { x: 200, y: 0 },
      sessionPolicy: "fresh",
      outputKey: "first",
      prompt: "Do not use tools or modify files. Reply with exactly: alpha",
    },
    {
      id: "continue",
      kind: "agent",
      title: "Continue",
      summary: "same thread",
      position: { x: 400, y: 0 },
      sessionPolicy: "continue",
      outputKey: "second",
      prompt: "Continue this conversation. Do not use tools or modify files. Reply with exactly: beta",
    },
    {
      id: "verify",
      kind: "agent",
      title: "Verify",
      summary: "fresh verifier",
      position: { x: 600, y: 0 },
      sessionPolicy: "fresh",
      outputKey: "review",
      prompt:
        "Do not use tools or modify files. Return only JSON. Set verdict to pass when state values below contain alpha and beta.\nfirst={{state.first}}\nsecond={{state.second}}",
      outputSchema: {
        type: "object",
        required: ["verdict"],
        additionalProperties: false,
        properties: { verdict: { type: "string", enum: ["pass", "fail"] } },
      },
    },
    {
      id: "decision",
      kind: "decision",
      title: "Pass?",
      summary: "route",
      position: { x: 800, y: 0 },
      question: "直前の検証結果はpassでしたか？（stateのreview.verdictがpassなら「はい」）",
    },
    { id: "end", kind: "end", title: "End", summary: "done", position: { x: 1000, y: 0 } },
    { id: "failed", kind: "end", title: "Failed", summary: "failed route", position: { x: 1000, y: 180 } },
  ],
  edges: [
    { id: "e1", source: "start", target: "first", label: "start" },
    { id: "e2", source: "first", target: "continue", label: "continue" },
    { id: "e3", source: "continue", target: "verify", label: "fresh" },
    { id: "e4", source: "verify", target: "decision", label: "decide" },
    { id: "e5", source: "decision", target: "end", label: "はい" },
    { id: "e6", source: "decision", target: "failed", label: "いいえ" },
  ],
};

store.saveWorkflow(workflow);
const run = store.createRun();
const runner = new LoopRunner(store);
runner.start();

try {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const current = store.getRun(run.id)!;
    if (["completed", "failed", "cancelled", "recovery_required"].includes(current.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const snapshot = store.getRunSnapshot(run.id)!;
  if (snapshot.run.status !== "completed") {
    throw new Error(`Runtime smoke ended in ${snapshot.run.status}: ${snapshot.run.terminationReason}`);
  }
  if (snapshot.sessions.length !== 2) {
    throw new Error(`Expected 2 sessions (Fresh, Continue, Fresh), got ${snapshot.sessions.length}.`);
  }
  if (new Set(snapshot.sessions.map((session) => session.codexThreadId)).size !== 2) {
    throw new Error("Fresh verifier did not create a distinct Codex thread.");
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        status: snapshot.run.status,
        state: snapshot.run.state,
        visits: snapshot.visits.map((visit) => ({ nodeId: visit.nodeId, status: visit.status, turnId: visit.codexTurnId })),
        sessions: snapshot.sessions.map((session) => ({
          id: session.id,
          threadId: session.codexThreadId,
          model: session.effectiveModel,
          cliVersion: session.cliVersion,
        })),
        eventCount: snapshot.events.length,
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
