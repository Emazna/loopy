export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type NodeKind = "start" | "agent" | "decision" | "end";
export type SessionPolicy = "continue" | "fresh";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export interface CanvasPosition {
  x: number;
  y: number;
}

export interface BaseWorkflowNode {
  id: string;
  kind: NodeKind;
  title: string;
  summary: string;
  position: CanvasPosition;
}

export interface StartNode extends BaseWorkflowNode {
  kind: "start";
}

export interface AgentNode extends BaseWorkflowNode {
  kind: "agent";
  prompt: string;
  sessionPolicy: SessionPolicy;
  outputKey: string;
  outputSchema?: JsonObject;
  /** Canvas上の矢印形の向き。ループを組みやすいよう左右を選べる。既定は右向き。 */
  direction?: "right" | "left";
}

export interface DecisionNode extends BaseWorkflowNode {
  kind: "decision";
  /** Codexに投げる質問。回答は分岐から出る線の基準ラベルの中から選ばれる。 */
  question: string;
}

export interface EndNode extends BaseWorkflowNode {
  kind: "end";
}

export type WorkflowNode = StartNode | AgentNode | DecisionNode | EndNode;

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  /** 分岐から出る線では「基準」（回答の選択肢）として使い、Canvas上にも表示する。 */
  label: string;
}

export interface WorkflowLimits {
  maxNodeVisits: number;
  maxVisitsPerNode: number;
  maxRunMinutes: number;
  turnTimeoutMinutes: number;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  model: string;
  cwd: string;
  approvalPolicy: "never";
  sandboxMode: "danger-full-access";
  reasoningEffort: ReasoningEffort;
  initialState: JsonObject;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  limits: WorkflowLimits;
  updatedAt: string;
}

export type RunStatus =
  | "queued"
  | "running"
  | "pause_requested"
  | "paused"
  | "waiting_input"
  | "interrupting"
  | "recovery_required"
  | "completed"
  | "failed"
  | "cancelled";

export type NodeVisitStatus =
  | "scheduled"
  | "running"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "outcome_unknown";

export interface RunRecord {
  id: string;
  workflowId: string;
  workflowVersionId: string;
  status: RunStatus;
  state: JsonObject;
  activeSessionId: string | null;
  currentNodeVisitId: string | null;
  nextNodeId: string | null;
  visitCount: number;
  controlRevision: number;
  terminationReason: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface RunSessionRecord {
  id: string;
  runId: string;
  codexThreadId: string;
  codexSessionId: string;
  forkedFromThreadId: string | null;
  createdByVisitId: string;
  cliVersion: string;
  effectiveModel: string;
  effectiveCwd: string;
  effectiveApprovalPolicy: string;
  effectiveSandbox: JsonValue;
  effectiveReasoningEffort: string | null;
  instructionSources: string[];
  status: "active" | "inactive" | "closed";
  createdAt: string;
}

export interface NodeVisitRecord {
  id: string;
  runId: string;
  nodeId: string;
  visitOrdinal: number;
  status: NodeVisitStatus;
  inputSessionId: string | null;
  outputSessionId: string | null;
  codexTurnId: string | null;
  renderedPrompt: string | null;
  outputText: string | null;
  output: JsonValue | null;
  selectedEdgeId: string | null;
  error: JsonValue | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface RunEventRecord {
  runId: string;
  seq: number;
  nodeVisitId: string | null;
  threadId: string | null;
  turnId: string | null;
  type: string;
  payload: JsonValue;
  createdAt: string;
}

export interface PendingInteractionRecord {
  id: string;
  runId: string;
  nodeVisitId: string;
  requestId: string;
  requestType: string;
  request: JsonValue;
  response: JsonValue | null;
  status: "pending" | "answered" | "cancelled" | "connection_lost";
  createdAt: string;
  resolvedAt: string | null;
}

export interface RunSnapshot {
  run: RunRecord;
  definition: WorkflowDefinition;
  visits: NodeVisitRecord[];
  sessions: RunSessionRecord[];
  events: RunEventRecord[];
  pendingInteractions: PendingInteractionRecord[];
}

export type ControlAction =
  | "pause"
  | "resume"
  | "interrupt"
  | "stop"
  | "retry"
  | "skip"
  | "answer_input";

export interface ValidationIssue {
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
}
