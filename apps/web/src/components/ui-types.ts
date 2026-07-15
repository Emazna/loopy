import type {
  NodeVisitStatus,
  RunEventRecord,
  RunSnapshot,
  ValidationIssue,
  WorkflowDefinition,
  WorkflowNode,
} from "@emazna/loop-runtime";
import type { Node } from "@xyflow/react";

export interface AppHealth {
  runnerStatus: string;
  runnerHeartbeat?: string | null;
  codexStatus: string;
  codexHome?: string | null;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  updatedAt: string;
}

export interface BootstrapPayload {
  workflow: WorkflowDefinition;
  workflows: WorkflowSummary[];
  latestRun: RunSnapshot | null;
  validationIssues: ValidationIssue[];
  health: AppHealth;
}

export interface CanvasNodeData extends Record<string, unknown> {
  workflowNode: WorkflowNode;
  visitCount: number;
  visitStatus: NodeVisitStatus | null;
  isCurrent: boolean;
  isNext: boolean;
}

export type CanvasFlowNode = Node<CanvasNodeData, "workflow">;

export type ActivityTab = "activity" | "agent" | "commands";

export interface ActivityItem {
  key: string;
  seq: number;
  type: string;
  nodeVisitId: string | null;
  createdAt: string;
  title: string;
  detail: string;
  tone: "neutral" | "info" | "success" | "warning" | "danger";
  category: ActivityTab | "files";
}

export type Notice = {
  kind: "success" | "error" | "info";
  message: string;
  action?: { label: string; run: () => void };
} | null;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function textValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function mergeEvents(events: RunEventRecord[], incoming: RunEventRecord): RunEventRecord[] {
  if (events.some((event) => event.seq === incoming.seq)) return events;
  return [...events, incoming].sort((left, right) => left.seq - right.seq).slice(-500);
}
