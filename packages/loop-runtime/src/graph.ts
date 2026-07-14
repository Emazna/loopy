import type {
  AgentNode,
  DecisionNode,
  JsonObject,
  JsonValue,
  ValidationIssue,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
} from "./types";

export function getNode(
  definition: WorkflowDefinition,
  nodeId: string,
): WorkflowNode | undefined {
  return definition.nodes.find((node) => node.id === nodeId);
}

export function outgoingEdges(
  definition: WorkflowDefinition,
  nodeId: string,
): WorkflowEdge[] {
  return definition.edges.filter((edge) => edge.source === nodeId);
}

export function getStateAtPath(state: JsonObject, path: string): JsonValue | undefined {
  let current: JsonValue = state;
  for (const segment of path.split(".").filter(Boolean)) {
    if (current === null || Array.isArray(current) || typeof current !== "object") {
      return undefined;
    }
    current = current[segment] as JsonValue;
    if (current === undefined) return undefined;
  }
  return current;
}

export function setStateAtPath(
  state: JsonObject,
  path: string,
  value: JsonValue,
): JsonObject {
  const segments = path.split(".").filter(Boolean);
  if (segments.length === 0) return state;
  const clone = structuredClone(state);
  let cursor: JsonObject = clone;
  for (const segment of segments.slice(0, -1)) {
    const existing = cursor[segment];
    if (existing === null || Array.isArray(existing) || typeof existing !== "object") {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as JsonObject;
  }
  cursor[segments.at(-1)!] = value;
  return clone;
}

/** 分岐の回答を保存するstateキー。パス区切りと衝突しないよう "." は使わない。 */
export function decisionStateKey(nodeId: string): string {
  return `decision_${nodeId.replaceAll(".", "_")}`;
}

/**
 * 分岐ノードを、Codexへの質問1ターンとして実行するための合成Agentノードに変換する。
 * 回答は分岐から出る線の基準ラベルの中から、構造化出力で1つ選ばせる。
 */
export function decisionAgentNode(
  definition: WorkflowDefinition,
  node: DecisionNode,
): AgentNode {
  const choices = outgoingEdges(definition, node.id).map((edge) => edge.label);
  const prompt = [
    "これまでの作業内容をふまえて、次の質問に答えてください。",
    "",
    `質問: ${node.question}`,
    "",
    "次の選択肢から、最も当てはまるものを1つだけ選んでください。",
    ...choices.map((choice) => `- ${choice}`),
    "",
    '回答は次のJSONだけを返してください。説明の文章は不要です。',
    '{"choice": "選んだ選択肢"}',
  ].join("\n");

  return {
    id: node.id,
    kind: "agent",
    title: node.title,
    summary: node.summary,
    position: node.position,
    prompt,
    // 判断は直前までの文脈に基づくため、セッションを引き継いで質問する。
    sessionPolicy: "continue",
    outputKey: decisionStateKey(node.id),
    outputSchema: {
      type: "object",
      required: ["choice"],
      additionalProperties: false,
      properties: {
        choice: { type: "string", enum: choices },
      },
    },
  };
}

export function selectOutgoingEdge(
  definition: WorkflowDefinition,
  nodeId: string,
  state: JsonObject,
): WorkflowEdge | undefined {
  const edges = outgoingEdges(definition, nodeId);
  const node = getNode(definition, nodeId);
  if (node?.kind === "decision") {
    const answer = getStateAtPath(state, `${decisionStateKey(nodeId)}.choice`);
    if (typeof answer !== "string") return undefined;
    return edges.find((edge) => edge.label === answer);
  }
  return edges.length === 1 ? edges[0] : undefined;
}

function isAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/") || value.startsWith("\\\\");
}

export function validateWorkflow(definition: WorkflowDefinition): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const ids = new Set<string>();
  for (const node of definition.nodes) {
    if (ids.has(node.id)) {
      issues.push({ code: "duplicate_node", message: `ノードID ${node.id} が重複しています。`, nodeId: node.id });
    }
    ids.add(node.id);
    if (!node.title.trim()) {
      issues.push({ code: "missing_title", message: "ノードのタイトルを入力してください。", nodeId: node.id });
    }
    if (node.kind === "agent") {
      if (!node.prompt.trim()) issues.push({ code: "missing_prompt", message: "エージェントのプロンプトを入力してください。", nodeId: node.id });
      if (!node.outputKey.trim()) issues.push({ code: "missing_output_key", message: "エージェントの出力キーが設定されていません。", nodeId: node.id });
    }
    if (node.kind === "decision" && !node.question.trim()) {
      issues.push({ code: "missing_question", message: "分岐の質問を入力してください。", nodeId: node.id });
    }
  }

  const starts = definition.nodes.filter((node) => node.kind === "start");
  if (starts.length !== 1) {
    issues.push({ code: "start_count", message: "開始ノードはちょうど1つ必要です。" });
  }
  if (!definition.nodes.some((node) => node.kind === "end")) {
    issues.push({ code: "missing_end", message: "終了ノードを1つ以上置いてください。" });
  }
  if (!definition.model.trim()) issues.push({ code: "missing_model", message: "モデルを入力してください。" });
  if (!isAbsolutePath(definition.cwd)) issues.push({ code: "invalid_cwd", message: "作業フォルダは絶対パスで指定してください。" });

  const edgeIds = new Set<string>();
  for (const edge of definition.edges) {
    if (edgeIds.has(edge.id)) {
      issues.push({ code: "duplicate_edge", message: `線のID ${edge.id} が重複しています。`, edgeId: edge.id });
    }
    edgeIds.add(edge.id);
    if (!ids.has(edge.source) || !ids.has(edge.target)) {
      issues.push({ code: "dangling_edge", message: `線 ${edge.id} のつなぎ先が見つかりません。`, edgeId: edge.id });
    }
    if (!edge.label.trim() && getNode(definition, edge.source)?.kind !== "decision") {
      issues.push({ code: "missing_edge_label", message: "線の内部ラベルが空です。", edgeId: edge.id });
    }
    if (getNode(definition, edge.target)?.kind === "start") {
      issues.push({ code: "edge_to_start", message: "開始ノードへ入る線は作れません。", edgeId: edge.id });
    }
  }

  for (const node of definition.nodes) {
    const edges = outgoingEdges(definition, node.id);
    if (node.kind === "start" && edges.length !== 1) {
      issues.push({ code: "start_outgoing", message: "開始ノードから出る線はちょうど1本にしてください。", nodeId: node.id });
    }
    if (node.kind === "agent" && edges.length !== 1) {
      issues.push({ code: "agent_outgoing", message: "エージェントから出る線は1本にしてください。分けたい場合は分岐ノードを使います。", nodeId: node.id });
    }
    if (node.kind === "end" && edges.length !== 0) {
      issues.push({ code: "end_outgoing", message: "終了ノードから線は出せません。", nodeId: node.id });
    }
    if (node.kind !== "decision") continue;

    if (edges.length < 2) {
      issues.push({ code: "decision_outgoing", message: "分岐からは線を2本以上出してください（例：はい / いいえ）。", nodeId: node.id });
    }
    const labels = new Set<string>();
    for (const edge of edges) {
      const label = edge.label.trim();
      if (!label) {
        issues.push({ code: "missing_choice_label", message: "分岐から出る線には基準（回答の選択肢）を入力してください。", edgeId: edge.id });
        continue;
      }
      if (labels.has(label)) {
        issues.push({ code: "duplicate_choice_label", message: `基準「${label}」が同じ分岐の中で重複しています。`, edgeId: edge.id });
      }
      labels.add(label);
    }
  }

  if (starts.length === 1) {
    const visited = new Set<string>();
    const queue = [starts[0]!.id];
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (visited.has(next)) continue;
      visited.add(next);
      for (const edge of outgoingEdges(definition, next)) queue.push(edge.target);
    }
    for (const node of definition.nodes) {
      if (!visited.has(node.id)) {
        issues.push({ code: "unreachable_node", message: `「${node.title}」に開始ノードから到達できません。`, nodeId: node.id });
      }
    }
  }

  const limits = definition.limits;
  if (
    !Number.isFinite(limits.maxNodeVisits) ||
    !Number.isFinite(limits.maxVisitsPerNode) ||
    !Number.isFinite(limits.maxRunMinutes) ||
    !Number.isFinite(limits.turnTimeoutMinutes) ||
    limits.maxNodeVisits < 1 ||
    limits.maxVisitsPerNode < 1 ||
    limits.maxRunMinutes < 1 ||
    limits.turnTimeoutMinutes < 1
  ) {
    issues.push({ code: "invalid_limits", message: "回数と時間の上限は1以上の数値にしてください。" });
  }
  return issues;
}

export function renderPrompt(template: string, state: JsonObject): string {
  return template.replace(/\{\{\s*state(?:\.([\w.-]+))?\s*\}\}/g, (_match, path?: string) => {
    const value = path ? getStateAtPath(state, path) : state;
    if (typeof value === "string") return value;
    return JSON.stringify(value ?? null, null, 2);
  });
}

export function parseStructuredOutput(text: string): JsonValue {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced?.[1] ?? trimmed) as JsonValue;
}
