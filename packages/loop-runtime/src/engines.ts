import type { EngineKind, ReasoningEffort, WorkflowDefinition } from "./types";

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
  // アカウントのモデルカタログ（models_cache.json, Codex CLI 0.144系）と揃える。
  codex: [
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.5",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.3-codex-spark",
  ],
  claude: ["claude-sonnet-5", "claude-fable-5", "claude-opus-4-8", "claude-haiku-4-5-20251001"],
};

/** インテリジェンス（reasoning effort）の表示順と日本語ラベル。 */
export const EFFORT_LABELS: Array<{ id: ReasoningEffort; label: string }> = [
  { id: "low", label: "低" },
  { id: "medium", label: "中" },
  { id: "high", label: "高" },
  { id: "xhigh", label: "XHigh" },
  { id: "max", label: "Max" },
  { id: "ultra", label: "Ultra" },
];

/** インテリジェンスの表示名。未知の値はそのまま返す。 */
export function effortLabel(effort: string): string {
  return EFFORT_LABELS.find((item) => item.id === effort)?.label ?? effort;
}

/**
 * モデルごとに選べるインテリジェンス段階。
 * GPT-5.6系: Sol/Terraはultraまで、Lunaはmaxまで。それ以外はxhighまで。
 * Claudeはインテリジェンス指定を使わない（ランナー側で無視される）ので空を返す。
 */
export function effortsForModel(engine: EngineKind, model: string): ReasoningEffort[] {
  if (engine === "claude") return [];
  if (model === "gpt-5.6-sol" || model === "gpt-5.6-terra") {
    return ["low", "medium", "high", "xhigh", "max", "ultra"];
  }
  if (model === "gpt-5.6-luna") {
    return ["low", "medium", "high", "xhigh", "max"];
  }
  return ["low", "medium", "high", "xhigh"];
}

/** モデルが対応する範囲へインテリジェンスを収める。対応外なら選べる中で最も深い段階にする。 */
export function clampEffortForModel(
  engine: EngineKind,
  model: string,
  effort: ReasoningEffort,
): ReasoningEffort {
  const allowed = effortsForModel(engine, model);
  if (allowed.length === 0 || allowed.includes(effort)) return effort;
  return allowed[allowed.length - 1]!;
}

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
