import { describe, expect, it } from "vitest";
import {
  createDefaultWorkflow,
  decisionAgentNode,
  decisionStateKey,
  parseStructuredOutput,
  renderPrompt,
  selectOutgoingEdge,
  setStateAtPath,
  validateWorkflow,
  type DecisionNode,
  type WorkflowDefinition,
} from "@emazna/loop-runtime";

// 既定のワークフローは線形（開始→計画→実装→確認→完了）。
// 分岐はCodexが質問に答えて、基準ラベルの線を選ぶ。テストでは分岐入りを組み立てて検証する。
function decisionWorkflow(): WorkflowDefinition {
  const workflow = createDefaultWorkflow("D:\\workspace", "gpt-5.4");
  const end = workflow.nodes.find((node) => node.id === "end")!;
  end.position = { x: 1260, y: 190 };
  workflow.nodes.push(
    {
      id: "decision",
      kind: "decision",
      title: "分岐",
      summary: "",
      position: { x: 1000, y: 170 },
      question: "修正点がもう存在しないかどうか",
    },
    {
      id: "fix",
      kind: "agent",
      title: "修正",
      summary: "",
      position: { x: 790, y: 360 },
      sessionPolicy: "continue",
      outputKey: "implementation",
      prompt: "指摘を反映して直してください。",
    },
  );
  workflow.edges = workflow.edges.filter((edge) => edge.id !== "e-verify-end");
  workflow.edges.push(
    { id: "e-verify-decision", source: "verify", target: "decision", label: "次へ" },
    { id: "e-decision-end", source: "decision", target: "end", label: "はい" },
    { id: "e-decision-fix", source: "decision", target: "fix", label: "いいえ" },
    { id: "e-fix-verify", source: "fix", target: "verify", label: "次へ" },
  );
  return workflow;
}

describe("workflow graph", () => {
  it("ships a valid bounded default workflow", () => {
    const workflow = createDefaultWorkflow("D:\\workspace", "gpt-5.4");
    expect(validateWorkflow(workflow)).toEqual([]);
  });

  it("keeps a valid workflow when a decision branch is added", () => {
    expect(validateWorkflow(decisionWorkflow())).toEqual([]);
  });

  it("routes a decision by the answer stored in state", () => {
    const workflow = decisionWorkflow();
    const yes = setStateAtPath({}, `${decisionStateKey("decision")}.choice`, "はい");
    const no = setStateAtPath({}, `${decisionStateKey("decision")}.choice`, "いいえ");
    expect(selectOutgoingEdge(workflow, "decision", yes)?.target).toBe("end");
    expect(selectOutgoingEdge(workflow, "decision", no)?.target).toBe("fix");
    expect(selectOutgoingEdge(workflow, "decision", {})).toBeUndefined();
    expect(
      selectOutgoingEdge(workflow, "decision", setStateAtPath({}, `${decisionStateKey("decision")}.choice`, "たぶん")),
    ).toBeUndefined();
  });

  it("builds a decision question turn with the edge labels as choices", () => {
    const workflow = decisionWorkflow();
    const node = workflow.nodes.find((candidate) => candidate.id === "decision") as DecisionNode;
    const agent = decisionAgentNode(workflow, node);

    expect(agent.id).toBe("decision");
    expect(agent.sessionPolicy).toBe("continue");
    expect(agent.outputKey).toBe(decisionStateKey("decision"));
    expect(agent.prompt).toContain("修正点がもう存在しないかどうか");
    expect(agent.prompt).toContain("- はい");
    expect(agent.prompt).toContain("- いいえ");
    const choices = (agent.outputSchema as { properties: { choice: { enum: string[] } } }).properties.choice.enum;
    expect(choices).toEqual(["はい", "いいえ"]);
  });

  it("keeps single-edge routing for non-decision nodes", () => {
    const workflow = createDefaultWorkflow("D:\\workspace", "gpt-5.4");
    expect(selectOutgoingEdge(workflow, "plan", {})?.target).toBe("implement");
  });

  it("maps state explicitly and renders prompts", () => {
    const state = setStateAtPath({ task: "check" }, "review.verdict", "pass");
    expect(state).toEqual({ task: "check", review: { verdict: "pass" } });
    expect(renderPrompt("Task={{state.task}} Result={{state.review}}", state)).toContain('Result={\n  "verdict": "pass"\n}');
  });

  it("accepts fenced structured output", () => {
    expect(parseStructuredOutput('```json\n{"choice":"はい"}\n```')).toEqual({ choice: "はい" });
  });

  it("rejects non-positive and non-finite time limits", () => {
    const workflow = createDefaultWorkflow("D:\\workspace", "gpt-5.4");
    workflow.limits.maxRunMinutes = 0;
    workflow.limits.turnTimeoutMinutes = Number.NaN;
    expect(validateWorkflow(workflow)).toContainEqual({
      code: "invalid_limits",
      message: "回数と時間の上限は1以上の数値にしてください。",
    });
  });

  it("requires a question and at least two labeled choices on decisions", () => {
    const workflow = decisionWorkflow();
    const decision = workflow.nodes.find((node) => node.id === "decision") as DecisionNode;
    decision.question = "  ";
    workflow.edges = workflow.edges.filter((edge) => edge.id !== "e-decision-fix");

    const issues = validateWorkflow(workflow);

    expect(issues.some((issue) => issue.code === "missing_question" && issue.nodeId === "decision")).toBe(true);
    expect(issues.some((issue) => issue.code === "decision_outgoing" && issue.nodeId === "decision")).toBe(true);
  });

  it("rejects duplicate and empty choice labels", () => {
    const workflow = decisionWorkflow();
    workflow.edges.push({ id: "e-decision-dup", source: "decision", target: "fix", label: "はい" });
    const noEdge = workflow.edges.find((edge) => edge.id === "e-decision-fix")!;
    noEdge.label = "  ";

    const issues = validateWorkflow(workflow);

    expect(issues.some((issue) => issue.code === "duplicate_choice_label")).toBe(true);
    expect(issues.some((issue) => issue.code === "missing_choice_label" && issue.edgeId === "e-decision-fix")).toBe(true);
  });

  it("rejects ambiguous Start routes", () => {
    const workflow = decisionWorkflow();
    workflow.edges.push({ id: "extra-start", source: "start", target: "end", label: "ambiguous" });

    const issues = validateWorkflow(workflow);

    expect(issues.some((issue) => issue.code === "start_outgoing" && issue.nodeId === "start")).toBe(true);
  });
});
