import { describe, expect, it } from "vitest";
import {
  clampEffortForModel,
  createDefaultWorkflow,
  effortLabel,
  effortsForModel,
  ENGINE_MODELS,
  validateWorkflow,
} from "@emazna/loop-runtime";

describe("engine model catalog", () => {
  it("offers the GPT-5.6 family for codex", () => {
    expect(ENGINE_MODELS.codex).toContain("gpt-5.6-sol");
    expect(ENGINE_MODELS.codex).toContain("gpt-5.6-terra");
    expect(ENGINE_MODELS.codex).toContain("gpt-5.6-luna");
  });
});

describe("reasoning effort per model", () => {
  it("allows up to ultra on sol/terra, max on luna, xhigh elsewhere", () => {
    expect(effortsForModel("codex", "gpt-5.6-sol")).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(effortsForModel("codex", "gpt-5.6-terra")).toContain("ultra");
    expect(effortsForModel("codex", "gpt-5.6-luna")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(effortsForModel("codex", "gpt-5.4")).toEqual(["low", "medium", "high", "xhigh"]);
    // Claudeはインテリジェンス指定を使わないので選択肢なし。
    expect(effortsForModel("claude", "claude-sonnet-5")).toEqual([]);
  });

  it("clamps unsupported efforts down to the deepest supported level", () => {
    // sol(ultra) → gpt-5.4 に切り替えたら xhigh に収める。
    expect(clampEffortForModel("codex", "gpt-5.4", "ultra")).toBe("xhigh");
    expect(clampEffortForModel("codex", "gpt-5.6-luna", "ultra")).toBe("max");
    expect(clampEffortForModel("codex", "gpt-5.6-sol", "ultra")).toBe("ultra");
    // Claudeでは何を持っていても変えない（無視されるだけ）。
    expect(clampEffortForModel("claude", "claude-sonnet-5", "ultra")).toBe("ultra");
  });

  it("labels efforts for the UI", () => {
    expect(effortLabel("ultra")).toBe("Ultra");
    expect(effortLabel("low")).toBe("低");
  });
});

describe("workflow validation of reasoning effort", () => {
  it("rejects an effort the codex model does not support", () => {
    const workflow = createDefaultWorkflow("D:\\workspace", "gpt-5.4");
    workflow.reasoningEffort = "ultra";
    const codes = validateWorkflow(workflow).map((issue) => issue.code);
    expect(codes).toContain("invalid_reasoning_effort");
  });

  it("accepts ultra on gpt-5.6-sol", () => {
    const workflow = createDefaultWorkflow("D:\\workspace", "gpt-5.6-sol");
    workflow.reasoningEffort = "ultra";
    expect(validateWorkflow(workflow)).toEqual([]);
  });

  it("does not restrict effort for the claude engine", () => {
    const workflow = createDefaultWorkflow("D:\\workspace", "claude-sonnet-5");
    workflow.engine = "claude";
    workflow.reasoningEffort = "ultra";
    expect(validateWorkflow(workflow)).toEqual([]);
  });
});
