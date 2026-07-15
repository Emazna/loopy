import type { EngineKind, WorkflowDefinition } from "./types";

/** UIの選択肢と表示名。 */
export const ENGINES: Array<{ id: EngineKind; label: string }> = [
  { id: "codex", label: "Codex" },
  { id: "claude", label: "Claude" },
];

/**
 * エンジンごとに選べるモデル。社内LLM APIワーカーの許可リストと揃える。
 * 先頭がそのエンジンの既定モデル。
 */
export const ENGINE_MODELS: Record<EngineKind, string[]> = {
  codex: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.5"],
  claude: ["claude-sonnet-5", "claude-fable-5", "claude-opus-4-8", "claude-haiku-4-5-20251001"],
};

export function isEngineKind(value: unknown): value is EngineKind {
  return value === "codex" || value === "claude";
}

/** 保存済みワークフローのエンジン。古いデータ（engine未設定）はcodexとして扱う。 */
export function workflowEngine(definition: Pick<WorkflowDefinition, "engine">): EngineKind {
  return definition.engine === "claude" ? "claude" : "codex";
}

export function defaultModelForEngine(engine: EngineKind): string {
  return ENGINE_MODELS[engine][0]!;
}
