import type { WorkflowDefinition } from "./types";

export function createDefaultWorkflow(
  cwd: string,
  model = "gpt-5.4",
): WorkflowDefinition {
  const now = new Date().toISOString();

  return {
    id: "default",
    name: "サンプルワークフロー",
    model,
    cwd,
    approvalPolicy: "never",
    sandboxMode: "danger-full-access",
    reasoningEffort: "high",
    initialState: {},
    limits: {
      maxNodeVisits: 60,
      maxVisitsPerNode: 20,
      maxRunMinutes: 120,
      turnTimeoutMinutes: 30,
    },
    nodes: [
      {
        id: "start",
        kind: "start",
        title: "開始",
        summary: "",
        position: { x: 40, y: 190 },
      },
      {
        id: "plan",
        kind: "agent",
        title: "計画",
        summary: "",
        position: { x: 250, y: 170 },
        sessionPolicy: "continue",
        outputKey: "plan",
        prompt:
          "このワークスペースを調べて、安全に直せそうな小さな改善点を1つ見つけ、進め方を簡単にまとめてください。まだファイルは変更しないでください。",
      },
      {
        id: "implement",
        kind: "agent",
        title: "実装",
        summary: "",
        position: { x: 520, y: 170 },
        sessionPolicy: "continue",
        outputKey: "implementation",
        prompt:
          "先ほどまとめた方針にそって対応してください。ファイルを変更する場合は、影響が小さい範囲だけにしてください。行った作業を簡潔に報告してください。",
      },
      {
        id: "verify",
        kind: "agent",
        title: "確認",
        summary: "",
        position: { x: 790, y: 170 },
        sessionPolicy: "continue",
        outputKey: "review",
        prompt:
          "ここまでの作業を見直し、問題がないか確認してください。必要ならコマンドを実行して確かめ、結果を報告してください。",
      },
      {
        id: "end",
        kind: "end",
        title: "完了",
        summary: "",
        position: { x: 1060, y: 190 },
      },
    ],
    edges: [
      { id: "e-start-plan", source: "start", target: "plan", label: "次へ" },
      { id: "e-plan-implement", source: "plan", target: "implement", label: "次へ" },
      { id: "e-implement-verify", source: "implement", target: "verify", label: "次へ" },
      { id: "e-verify-end", source: "verify", target: "end", label: "次へ" },
    ],
    updatedAt: now,
  };
}
