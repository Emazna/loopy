"use client";

import {
  defaultModelForEngine,
  ENGINE_MODELS,
  ENGINES,
  validateWorkflow,
  workflowEngine,
  type ControlAction,
  type EngineKind,
  type JsonValue,
  type RunSnapshot,
  type RunStatus,
  type ValidationIssue,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
} from "@emazna/loop-runtime";
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  type Connection,
  Controls,
  MarkerType,
  ReactFlow,
  type Edge,
  type NodeChange,
  type NodeTypes,
} from "@xyflow/react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Copy,
  Plus,
  Trash2,
  CircleAlert,
  CirclePause,
  CircleStop,
  GitBranch,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldAlert,
  Square,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityDock } from "./ActivityDock";
import {
  EdgeInspector,
  NodeInspector,
  PendingInputPanel,
} from "./InspectorPanels";
import type {
  BootstrapPayload,
  CanvasFlowNode,
  Notice,
  WorkflowSummary,
} from "./ui-types";
import { mergeEvents } from "./ui-types";
import { WorkflowNodeCard } from "./WorkflowNodeCard";

const NODE_TYPES: NodeTypes = { workflow: WorkflowNodeCard };
const TERMINAL_STATUSES = new Set<RunStatus>(["completed", "failed", "cancelled"]);
const LOCKED_STATUSES = new Set<RunStatus>([
  "queued",
  "running",
  "pause_requested",
  "paused",
  "waiting_input",
  "interrupting",
  "recovery_required",
]);

const STATUS_LABEL: Record<RunStatus, string> = {
  queued: "開始待ち",
  running: "実行中",
  pause_requested: "区切りで一時停止します",
  paused: "一時停止中",
  waiting_input: "回答待ち",
  interrupting: "中断中",
  recovery_required: "要復旧確認",
  completed: "完了",
  failed: "失敗",
  cancelled: "停止済み",
};

const CONTROL_NOTICE: Record<ControlAction, string> = {
  pause: "区切りで一時停止するよう伝えました。",
  resume: "再開を伝えました。",
  interrupt: "今すぐ中断するよう伝えました。",
  stop: "停止を伝えました。",
  retry: "このボックスの再実行を伝えました。",
  skip: "スキップを伝えました。",
  answer_input: "回答を送信しました。",
};

class ApiError extends Error {
  issues?: ValidationIssue[];

  constructor(message: string, issues?: ValidationIssue[]) {
    super(message);
    this.name = "ApiError";
    this.issues = issues;
  }
}

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: options?.body
      ? { "content-type": "application/json", ...(options.headers ?? {}) }
      : options?.headers,
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    issues?: ValidationIssue[];
  } & T;
  if (!response.ok) {
    const issueMessage = payload.issues?.map((issue) => issue.message).join(" ");
    throw new ApiError(payload.error || issueMessage || response.statusText, payload.issues);
  }
  return payload;
}

function eventNodeState(snapshot: RunSnapshot | null, nodeId: string) {
  const visits = snapshot?.visits.filter((visit) => visit.nodeId === nodeId) ?? [];
  const latest = visits.at(-1);
  return {
    visitCount: visits.length,
    visitStatus: latest?.status ?? null,
    isCurrent: latest?.id === snapshot?.run.currentNodeVisitId,
    isNext: Boolean(
      snapshot &&
      !snapshot.run.currentNodeVisitId &&
      snapshot.run.nextNodeId === nodeId &&
      !TERMINAL_STATUSES.has(snapshot.run.status),
    ),
  };
}

function createCanvasNodes(
  workflow: WorkflowDefinition,
  snapshot: RunSnapshot | null,
  selectedNodeId: string | null,
): CanvasFlowNode[] {
  return workflow.nodes.map((workflowNode) => {
    const runState = eventNodeState(snapshot, workflowNode.id);
    return {
      id: workflowNode.id,
      type: "workflow",
      position: workflowNode.position,
      selected: workflowNode.id === selectedNodeId,
      data: {
        workflowNode,
        ...runState,
      },
    };
  });
}

function createCanvasEdges(
  workflow: WorkflowDefinition,
  snapshot: RunSnapshot | null,
  selectedEdgeId: string | null,
): Edge[] {
  const selectedEdgeIds = new Set(
    (snapshot?.visits ?? []).flatMap((visit) => visit.selectedEdgeId ? [visit.selectedEdgeId] : []),
  );
  const latestSelectedEdge = [...(snapshot?.visits ?? [])].reverse().find((visit) => visit.selectedEdgeId)?.selectedEdgeId;
  const decisionNodeIds = new Set(
    workflow.nodes.filter((node) => node.kind === "decision").map((node) => node.id),
  );
  return workflow.edges.map((edge) => {
    const traversed = selectedEdgeIds.has(edge.id);
    const latest = edge.id === latestSelectedEdge;
    const selected = edge.id === selectedEdgeId;
    const fromDecision = decisionNodeIds.has(edge.source);
    const color = selected ? "#B05838" : traversed ? "#286888" : "#AEB7C2";
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: "smoothstep",
      animated: latest && snapshot ? !TERMINAL_STATUSES.has(snapshot.run.status) : false,
      selected,
      // 分岐から出る線は「基準」（回答の選択肢）をラベルとして線上に表示する。
      label: fromDecision ? edge.label : undefined,
      labelStyle: { fill: selected ? "#8B412B" : traversed ? "#1F5269" : "#4b5560", fontSize: 13, fontWeight: 750 },
      labelBgStyle: { fill: "#FFFFFF", fillOpacity: 0.95 },
      labelBgPadding: [7, 4] as [number, number],
      labelBgBorderRadius: 6,
      className: `${traversed ? "flow-edge--traversed" : ""} ${latest ? "flow-edge--latest" : ""} ${selected ? "flow-edge--selected" : ""}`.trim(),
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
      style: {
        stroke: color,
        strokeWidth: selected ? 3 : traversed ? 2.2 : 1.5,
        strokeDasharray: fromDecision ? "7 5" : undefined,
      },
    };
  });
}

function activeRun(snapshot: RunSnapshot | null): boolean {
  return snapshot ? !TERMINAL_STATUSES.has(snapshot.run.status) : false;
}

export function LoopCanvasApp() {
  const [workflow, setWorkflow] = useState<WorkflowDefinition | null>(null);
  const [workflowList, setWorkflowList] = useState<WorkflowSummary[]>([]);
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null);
  const [canvasNodes, setCanvasNodes] = useState<CanvasFlowNode[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [fatalError, setFatalError] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [streamStatus, setStreamStatus] = useState<"idle" | "connecting" | "live" | "reconnecting">("idle");
  const [validationOpen, setValidationOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<"interrupt" | "stop" | null>(null);
  const [runConfirmOpen, setRunConfirmOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const refreshTimer = useRef<number | null>(null);

  const localIssues = useMemo(() => workflow ? validateWorkflow(workflow) : [], [workflow]);
  const selectedNode = workflow?.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedEdge = workflow?.edges.find((edge) => edge.id === selectedEdgeId) ?? null;
  const editorLocked = snapshot ? LOCKED_STATUSES.has(snapshot.run.status) : false;
  const editingLocked = editorLocked || busyAction === "save" || busyAction === "run";
  const pendingInteraction = snapshot?.pendingInteractions.find((interaction) => interaction.status === "pending") ?? null;
  const currentVisit = snapshot?.visits.find((visit) => visit.id === snapshot.run.currentNodeVisitId) ?? null;
  const currentNode = currentVisit ? snapshot?.definition.nodes.find((node) => node.id === currentVisit.nodeId) ?? null : null;
  const nextNode = !currentVisit && snapshot?.run.nextNodeId
    ? snapshot.definition.nodes.find((node) => node.id === snapshot.run.nextNodeId) ?? null
    : null;
  const runStatus = snapshot?.run.status ?? null;

  const loadBootstrap = useCallback(async () => {
    setLoading(true);
    setFatalError("");
    try {
      const requested = new URLSearchParams(window.location.search).get("workflow");
      const payload = await api<BootstrapPayload>(
        `/api/bootstrap${requested ? `?workflow=${encodeURIComponent(requested)}` : ""}`,
      );
      setWorkflow(payload.workflow);
      setWorkflowList(payload.workflows);
      setSnapshot(payload.latestRun);
      setSelectedNodeId(payload.workflow.nodes.find((node) => node.kind === "agent")?.id ?? payload.workflow.nodes[0]?.id ?? null);
      setDirty(false);
      // 存在しないIDを指定していた場合などは、実際に開いたワークフローへURLを揃える
      const canonical = `${window.location.pathname}?workflow=${encodeURIComponent(payload.workflow.id)}`;
      window.history.replaceState(null, "", canonical);
    } catch (error) {
      setFatalError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshRun = useCallback(async (runId: string) => {
    try {
      const payload = await api<{ run: RunSnapshot }>(`/api/runs/${encodeURIComponent(runId)}`);
      setSnapshot((current) => {
        if (current?.run.id !== runId) return current;
        const events = payload.run.events.reduce(
          (merged, event) => mergeEvents(merged, event),
          current.events,
        );
        return { ...payload.run, events };
      });
    } catch {
      // 進捗はSSE側でも表示している。次のpollで整合する。
    }
  }, []);

  useEffect(() => {
    void loadBootstrap();
  }, [loadBootstrap]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), notice.action ? 8_000 : 4_500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // 未保存の変更があるままタブを閉じる・再読み込みする事故を防ぐ。
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  useEffect(() => {
    if (!workflow) return;
    setCanvasNodes(createCanvasNodes(workflow, snapshot, selectedNodeId));
  }, [workflow, snapshot?.visits, snapshot?.run.currentNodeVisitId, snapshot?.run.status, selectedNodeId]);

  // 別タブなどで開始されたrunを拾えるよう、snapshotが無い間だけ軽くpollする。
  useEffect(() => {
    if (!workflow || snapshot) return;
    const timer = window.setInterval(async () => {
      try {
        const payload = await api<BootstrapPayload>(`/api/bootstrap?workflow=${encodeURIComponent(workflow.id)}`);
        setWorkflowList(payload.workflows);
        setSnapshot((current) => current ?? payload.latestRun);
      } catch {
        // 取得できなくても、この画面から開始したrunはstartRunで反映される。
      }
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [workflow, snapshot]);

  const runId = snapshot?.run.id ?? null;
  const runIsTerminal = snapshot ? TERMINAL_STATUSES.has(snapshot.run.status) : false;

  useEffect(() => {
    if (!runId || runIsTerminal) {
      setStreamStatus("idle");
      return;
    }

    const activeRunId = runId;
    setStreamStatus("connecting");
    const source = new EventSource(`/api/runs/${encodeURIComponent(activeRunId)}/events`);
    const poll = window.setInterval(() => void refreshRun(activeRunId), 2_500);

    function scheduleRefresh() {
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => void refreshRun(activeRunId), 220);
    }

    source.onopen = () => setStreamStatus("live");
    source.onerror = () => setStreamStatus("reconnecting");
    source.addEventListener("run-event", (rawEvent) => {
      try {
        const event = JSON.parse((rawEvent as MessageEvent<string>).data);
        setSnapshot((current) => {
          if (!current || current.run.id !== activeRunId) return current;
          return { ...current, events: mergeEvents(current.events, event) };
        });
        scheduleRefresh();
      } catch {
        setNotice({ kind: "error", message: "記録を読み取れませんでした。最新の状態を取り直します。" });
        scheduleRefresh();
      }
    });

    return () => {
      source.close();
      window.clearInterval(poll);
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    };
  }, [refreshRun, runId, runIsTerminal]);

  function patchNode(nodeId: string, patch: Partial<WorkflowNode>) {
    if (editingLocked) return;
    setWorkflow((current) => current ? {
      ...current,
      nodes: current.nodes.map((node) => node.id === nodeId ? { ...node, ...patch } as WorkflowNode : node),
    } : current);
    setDirty(true);
  }

  function changeEngine(engine: EngineKind) {
    if (editingLocked) return;
    // エンジンを切り替えたら、そのエンジンの既定モデルに合わせる。
    setWorkflow((current) => current ? { ...current, engine, model: defaultModelForEngine(engine) } : current);
    setDirty(true);
  }

  function changeModel(model: string) {
    if (editingLocked) return;
    setWorkflow((current) => current ? { ...current, model } : current);
    setDirty(true);
  }

  function addTopologyNode(kind: "agent" | "decision") {
    if (editingLocked || !workflow) return;
    const sameKindCount = workflow.nodes.filter((node) => node.kind === kind).length + 1;
    const usedIds = new Set(workflow.nodes.map((node) => node.id));
    let suffix = sameKindCount;
    let id = `${kind}-${suffix}`;
    while (usedIds.has(id)) id = `${kind}-${++suffix}`;
    const anchor = selectedNode;
    const fallbackIndex = workflow.nodes.length;
    const position = anchor
      ? { x: anchor.position.x + 260, y: anchor.position.y + 70 + (fallbackIndex % 3) * 36 }
      : { x: 180 + Math.floor(fallbackIndex / 4) * 260, y: 130 + (fallbackIndex % 4) * 150 };
    const title = kind === "agent" ? `実行 ${suffix}` : `分岐 ${suffix}`;
    // 既定は「前のブロックの内容を引き継ぐ（continue）」。プロンプトは空から書き始める。
    const node: WorkflowNode = kind === "agent"
      ? {
          id,
          kind,
          title,
          summary: "",
          position,
          prompt: "",
          sessionPolicy: "continue",
          outputKey: `agent_${suffix}`,
        }
      : { id, kind, title, summary: "", position, question: "" };
    setWorkflow((current) => current ? { ...current, nodes: [...current.nodes, node] } : current);
    setSelectedNodeId(id);
    setSelectedEdgeId(null);
    setDirty(true);
    setNotice({ kind: "info", message: `「${title}」を追加しました。端をdragして線でつなげます。` });
  }

  function deleteTopologyNode(nodeId: string) {
    if (editingLocked || !workflow) return;
    const node = workflow.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) return;
    if (node.kind === "start" || node.kind === "end") {
      setNotice({ kind: "error", message: "このブロックは削除できません。" });
      return;
    }
    const removedNode = node;
    const removedEdges = workflow.edges.filter((edge) => edge.source === nodeId || edge.target === nodeId);
    setWorkflow((current) => current ? {
      ...current,
      nodes: current.nodes.filter((candidate) => candidate.id !== nodeId),
      edges: current.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId),
    } : current);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setDirty(true);
    setNotice({
      kind: "info",
      message: `「${node.title}」${removedEdges.length > 0 ? `と線${removedEdges.length}本` : ""}を削除しました。`,
      action: {
        label: "元に戻す",
        run: () => {
          setWorkflow((current) => current ? {
            ...current,
            nodes: [...current.nodes, removedNode],
            edges: [...current.edges, ...removedEdges],
          } : current);
          setSelectedNodeId(removedNode.id);
          setDirty(true);
          setNotice({ kind: "success", message: "元に戻しました。" });
        },
      },
    });
  }

  function connectTopology(connection: Connection) {
    if (editingLocked || !connection.source || !connection.target || !workflow) return;
    if (workflow.edges.some((edge) => edge.source === connection.source && edge.target === connection.target)) {
      setNotice({ kind: "error", message: "同じつなぎ方の線がすでにあります。" });
      return;
    }
    const sourceNode = workflow.nodes.find((node) => node.id === connection.source);
    const targetNode = workflow.nodes.find((node) => node.id === connection.target);
    if (!sourceNode || !targetNode || sourceNode.kind === "end" || targetNode.kind === "start") return;
    const usedIds = new Set(workflow.edges.map((edge) => edge.id));
    let suffix = workflow.edges.length + 1;
    let id = `edge-${suffix}`;
    while (usedIds.has(id)) id = `edge-${++suffix}`;
    // 分岐から出る線には「基準」（回答の選択肢）を付ける。1本目は「はい」、2本目は「いいえ」。
    const sourceEdges = workflow.edges.filter((edge) => edge.source === sourceNode.id);
    const usedLabels = new Set(sourceEdges.map((edge) => edge.label));
    let choiceLabel = "次へ";
    if (sourceNode.kind === "decision") {
      if (!usedLabels.has("はい")) choiceLabel = "はい";
      else if (!usedLabels.has("いいえ")) choiceLabel = "いいえ";
      else {
        let optionNumber = sourceEdges.length + 1;
        while (usedLabels.has(`選択肢${optionNumber}`)) optionNumber += 1;
        choiceLabel = `選択肢${optionNumber}`;
      }
    }
    const edge: WorkflowEdge = {
      id,
      source: sourceNode.id,
      target: targetNode.id,
      label: choiceLabel,
    };
    setWorkflow((current) => current ? { ...current, edges: [...current.edges, edge] } : current);
    setSelectedNodeId(null);
    setSelectedEdgeId(id);
    setDirty(true);
    setNotice({
      kind: "info",
      message: sourceNode.kind === "decision"
        ? `「${sourceNode.title}」から基準「${choiceLabel}」の線を引きました。線を選ぶと基準を変更できます。`
        : `「${sourceNode.title}」から「${targetNode.title}」へつなぎました。`,
    });
  }

  function patchEdge(edgeId: string, patch: Partial<WorkflowEdge>) {
    if (editingLocked) return;
    setWorkflow((current) => current ? {
      ...current,
      edges: current.edges.map((edge) => edge.id === edgeId ? { ...edge, ...patch } : edge),
    } : current);
    setDirty(true);
  }

  function deleteTopologyEdge(edgeId: string) {
    if (editingLocked || !workflow) return;
    const edge = workflow.edges.find((candidate) => candidate.id === edgeId);
    if (!edge) return;
    const sourceTitle = workflow.nodes.find((node) => node.id === edge.source)?.title ?? edge.source;
    const targetTitle = workflow.nodes.find((node) => node.id === edge.target)?.title ?? edge.target;
    const removedEdge = edge;
    setWorkflow((current) => current ? {
      ...current,
      edges: current.edges.filter((candidate) => candidate.id !== edgeId),
    } : current);
    setSelectedEdgeId(null);
    setDirty(true);
    setNotice({
      kind: "info",
      message: `「${sourceTitle} → ${targetTitle}」の線を削除しました。`,
      action: {
        label: "元に戻す",
        run: () => {
          setWorkflow((current) => current ? { ...current, edges: [...current.edges, removedEdge] } : current);
          setDirty(true);
          setNotice({ kind: "success", message: "元に戻しました。" });
        },
      },
    });
  }

  async function saveWorkflow(): Promise<WorkflowDefinition | null> {
    if (!workflow) return null;
    const issues = validateWorkflow(workflow);
    if (issues.length > 0) {
      setValidationOpen(true);
      setNotice({ kind: "error", message: `保存の前に${issues.length}件の問題を直してください。` });
      return null;
    }
    setBusyAction("save");
    try {
      const payload = await api<{ workflow: WorkflowDefinition; issues: ValidationIssue[] }>("/api/workflow", {
        method: "PUT",
        body: JSON.stringify(workflow),
      });
      setWorkflow(payload.workflow);
      setDirty(false);
      setWorkflowList((current) => current.map((item) => item.id === payload.workflow.id ? { ...item, name: payload.workflow.name } : item));
      setNotice({ kind: "success", message: "保存しました。" });
      return payload.workflow;
    } catch (error) {
      if (error instanceof ApiError && error.issues?.length) setValidationOpen(true);
      setNotice({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      return null;
    } finally {
      setBusyAction(null);
    }
  }

  async function startRun() {
    if (!workflow || activeRun(snapshot)) return;
    const saved = dirty ? await saveWorkflow() : localIssues.length === 0 ? workflow : null;
    if (!saved) {
      setValidationOpen(true);
      return;
    }
    setBusyAction("run");
    try {
      const payload = await api<{ run: RunSnapshot }>("/api/runs", {
        method: "POST",
        body: JSON.stringify({ workflowId: workflow.id }),
      });
      setSnapshot(payload.run);
      setSelectedNodeId(payload.run.definition.nodes[0]?.id ?? null);
      setNotice({ kind: "success", message: "実行を始めました。この画面を閉じても実行は続きます。" });
    } catch (error) {
      setNotice({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyAction(null);
    }
  }

  async function controlRun(action: ControlAction, payload: JsonValue = {}) {
    if (!snapshot) return;
    const targetRunId = snapshot.run.id;
    setBusyAction(action);
    try {
      await api<{ commandId: string }>(`/api/runs/${encodeURIComponent(targetRunId)}/control`, {
        method: "POST",
        body: JSON.stringify({ action, payload }),
      });
      setSnapshot((current) => {
        if (!current || current.run.id !== targetRunId) return current;
        const optimisticStatus: Partial<Record<ControlAction, RunStatus>> = {
          pause: "pause_requested",
          resume: "queued",
          interrupt: "interrupting",
          stop: "interrupting",
        };
        return optimisticStatus[action]
          ? { ...current, run: { ...current.run, status: optimisticStatus[action]! } }
          : current;
      });
      setNotice({ kind: "info", message: CONTROL_NOTICE[action] });
      window.setTimeout(() => void refreshRun(targetRunId), 350);
    } catch (error) {
      setNotice({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyAction(null);
    }
  }

  useEffect(() => {
    function handleDeleteKey(event: KeyboardEvent) {
      if (editingLocked || (event.key !== "Delete" && event.key !== "Backspace")) return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) return;
      if (selectedEdgeId) {
        event.preventDefault();
        deleteTopologyEdge(selectedEdgeId);
      } else if (selectedNodeId) {
        event.preventDefault();
        deleteTopologyNode(selectedNodeId);
      }
    }
    window.addEventListener("keydown", handleDeleteKey);
    return () => window.removeEventListener("keydown", handleDeleteKey);
  }, [editingLocked, selectedEdgeId, selectedNodeId]);

  function switchWorkflow(id: string) {
    if (!workflow || id === workflow.id) return;
    window.location.href = `/?workflow=${encodeURIComponent(id)}`;
  }

  async function createWorkflow(sourceId?: string) {
    setBusyAction("workflow");
    try {
      const payload = await api<{ workflow: WorkflowDefinition }>("/api/workflows", {
        method: "POST",
        body: JSON.stringify(sourceId ? { sourceId } : {}),
      });
      window.location.href = `/?workflow=${encodeURIComponent(payload.workflow.id)}`;
    } catch (error) {
      setNotice({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      setBusyAction(null);
    }
  }

  async function deleteWorkflow() {
    if (!workflow) return;
    setDeleteConfirmOpen(false);
    setBusyAction("workflow");
    try {
      await api<{ ok: boolean }>(`/api/workflows/${encodeURIComponent(workflow.id)}`, { method: "DELETE" });
      window.location.href = "/";
    } catch (error) {
      setNotice({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      setBusyAction(null);
    }
  }

  function changeWorkflowName(name: string) {
    if (editingLocked) return;
    setWorkflow((current) => current ? { ...current, name } : current);
    setDirty(true);
  }

  if (loading) return <LoadingScreen />;
  if (fatalError || !workflow) return <ErrorScreen message={fatalError || "ワークフローを読み込めませんでした。"} onRetry={loadBootstrap} />;

  const canvasEdges = createCanvasEdges(workflow, snapshot, selectedEdgeId);
  const canPause = runStatus === "running";
  const canResume = runStatus === "paused";
  const canInterrupt = runStatus ? ["running", "pause_requested", "waiting_input"].includes(runStatus) : false;
  const canStop = snapshot ? !TERMINAL_STATUSES.has(snapshot.run.status) : false;
  const canRetry = runStatus === "recovery_required";

  return (
    <main className="loop-app">
      <header className="workbench-header">
        <div className="brand-lockup">
          <span className="brand-lockup__mark" aria-hidden="true"><Activity size={19} /></span>
          <div>
            <p>Emazna</p>
            <strong>Loopy</strong>
          </div>
        </div>

        <div className="header-context">
          <div className="environment-line">
            <select
              aria-label="ワークフローを切り替え"
              className="workflow-select"
              onChange={(event) => switchWorkflow(event.target.value)}
              value={workflow.id}
            >
              {(workflowList.some((item) => item.id === workflow.id)
                ? workflowList
                : [{ id: workflow.id, name: workflow.name, updatedAt: "" }, ...workflowList]
              ).map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
            <input
              aria-label="ワークフロー名"
              className="workflow-name-input"
              disabled={editingLocked}
              onChange={(event) => changeWorkflowName(event.target.value)}
              value={workflow.name}
            />
            <button className="wf-icon-button" disabled={busyAction !== null} onClick={() => void createWorkflow()} title="新しいワークフロー" type="button">
              <Plus aria-hidden="true" size={15} />
            </button>
            <button className="wf-icon-button" disabled={busyAction !== null} onClick={() => void createWorkflow(workflow.id)} title="このワークフローを複製" type="button">
              <Copy aria-hidden="true" size={15} />
            </button>
            <button
              className="wf-icon-button wf-icon-button--danger"
              disabled={busyAction !== null || activeRun(snapshot) || workflowList.length <= 1}
              onClick={() => setDeleteConfirmOpen(true)}
              title="このワークフローを削除"
              type="button"
            >
              <Trash2 aria-hidden="true" size={15} />
            </button>
            <select
              aria-label="実行エンジン"
              className="engine-select"
              disabled={editingLocked}
              onChange={(event) => changeEngine(event.target.value as EngineKind)}
              value={workflowEngine(workflow)}
            >
              {ENGINES.map((engine) => (
                <option key={engine.id} value={engine.id}>{engine.label}</option>
              ))}
            </select>
            <select
              aria-label="モデル"
              className="model-select"
              disabled={editingLocked}
              onChange={(event) => changeModel(event.target.value)}
              value={workflow.model}
            >
              {[...new Set([...ENGINE_MODELS[workflowEngine(workflow)], workflow.model])].map((model) => (
                <option key={model} value={model}>{model}</option>
              ))}
            </select>
            <code title={workflow.cwd}>{workflow.cwd}</code>
            <span className="save-state" data-dirty={dirty || undefined}>{dirty ? "未保存の変更" : "保存済み"}</span>
          </div>
        </div>

        <div className="header-actions">
          <button
            className="button button--secondary"
            disabled={busyAction !== null || editorLocked || !dirty}
            onClick={() => void saveWorkflow()}
            type="button"
          >
            <Save aria-hidden="true" size={15} />
            {busyAction === "save" ? "保存中…" : "保存"}
          </button>
          {!activeRun(snapshot) ? (
            <button className="button button--primary" disabled={busyAction !== null} onClick={() => setRunConfirmOpen(true)} type="button">
              <Play aria-hidden="true" size={15} />
              {busyAction === "run" ? "開始中…" : "実行"}
            </button>
          ) : (
            <ExecutionControls
              busyAction={busyAction}
              canInterrupt={canInterrupt}
              canPause={canPause}
              canResume={canResume}
              canRetry={canRetry}
              canStop={canStop}
              onControl={(action) => {
                if (action === "interrupt" || action === "stop") setConfirmAction(action);
                else void controlRun(action);
              }}
            />
          )}
        </div>
      </header>

      <section className="workbench">
        <section aria-label="ワークフローCanvas" className="canvas-panel panel-surface">
          <div className="canvas-toolbar">
            <div aria-label="ブロックを追加" className="block-palette" role="group">
              <span className="block-palette__title">ブロック</span>
              <div className="block-palette__buttons">
                <button disabled={editingLocked} onClick={() => addTopologyNode("agent")} type="button">
                  <Play aria-hidden="true" size={14} />
                  実行
                </button>
                <button disabled={editingLocked} onClick={() => addTopologyNode("decision")} type="button">
                  <GitBranch aria-hidden="true" size={14} />
                  分岐
                </button>
              </div>
            </div>
            {/* 下書き中はステータスを出さない（実行中・実行後だけ表示） */}
            {snapshot ? (
              <div className="canvas-status">
                <span className="canvas-status__eyebrow">実行 {snapshot.run.id.slice(0, 8)}</span>
                <strong>{STATUS_LABEL[snapshot.run.status]}</strong>
                {currentNode ? <small>実行中: {currentNode.title}</small> : nextNode ? <small>次: {nextNode.title}</small> : null}
              </div>
            ) : null}
          </div>
          <ReactFlow<CanvasFlowNode, Edge>
            edges={canvasEdges}
            edgesFocusable
            fitView
            fitViewOptions={{ padding: 0.18, maxZoom: 1.1 }}
            minZoom={0.25}
            nodeTypes={NODE_TYPES}
            nodes={canvasNodes}
            nodesConnectable={!editingLocked}
            nodesDraggable={!editingLocked}
            nodesFocusable
            onConnect={connectTopology}
            onEdgeClick={(_event, edge) => {
              setSelectedEdgeId(edge.id);
              setSelectedNodeId(null);
            }}
            onNodeClick={(_event, node) => {
              setSelectedNodeId(node.id);
              setSelectedEdgeId(null);
            }}
            onNodeDragStop={(_event, node) => patchNode(node.id, { position: node.position })}
            onNodesChange={(changes: NodeChange<CanvasFlowNode>[]) =>
              setCanvasNodes((current) => applyNodeChanges(changes, current))
            }
            onPaneClick={() => {
              setSelectedNodeId(null);
              setSelectedEdgeId(null);
            }}
            panOnScroll
            proOptions={{ hideAttribution: true }}
            selectionOnDrag
            deleteKeyCode={null}
            connectionLineStyle={{ stroke: "#B05838", strokeWidth: 2 }}
          >
            <Background color="#DCE2E8" gap={24} size={1} variant={BackgroundVariant.Dots} />
            <Controls position="bottom-left" showInteractive={false} />
          </ReactFlow>
          {editorLocked ? (
            <div className="canvas-lock-banner">
              <ShieldAlert aria-hidden="true" size={14} />
              実行中は編集できません。終わると編集できます。
            </div>
          ) : null}
        </section>

        <div className="inspector-column">
          {pendingInteraction ? (
            <PendingInputPanel
              busy={busyAction === "answer_input"}
              interaction={pendingInteraction}
              onAnswer={(interactionId, answers) => controlRun("answer_input", { interactionId, answers })}
            />
          ) : null}
          {selectedEdge ? (
            <EdgeInspector
              disabled={editingLocked}
              edge={selectedEdge}
              onChange={patchEdge}
              onDelete={deleteTopologyEdge}
              sourceKind={workflow.nodes.find((node) => node.id === selectedEdge.source)?.kind ?? "agent"}
              sourceTitle={workflow.nodes.find((node) => node.id === selectedEdge.source)?.title ?? selectedEdge.source}
              targetTitle={workflow.nodes.find((node) => node.id === selectedEdge.target)?.title ?? selectedEdge.target}
            />
          ) : (
            <NodeInspector
              disabled={editingLocked}
              node={selectedNode}
              onChange={patchNode}
              onDelete={deleteTopologyNode}
            />
          )}
        </div>

        <ActivityDock snapshot={snapshot} streamStatus={streamStatus} />
      </section>

      <p className="sr-status" aria-live="polite">
        {snapshot ? `実行の状態: ${STATUS_LABEL[snapshot.run.status]}。${currentNode ? `実行中のボックス: ${currentNode.title}。` : ""}` : "実行はまだありません。"}
      </p>

      {notice ? (
        <div className="toast" data-kind={notice.kind} role={notice.kind === "error" ? "alert" : "status"}>
          {notice.kind === "success" ? <CheckCircle2 aria-hidden="true" size={17} /> : notice.kind === "error" ? <CircleAlert aria-hidden="true" size={17} /> : <Activity aria-hidden="true" size={17} />}
          <span>{notice.message}</span>
          {notice.action ? (
            <button className="toast-action" onClick={notice.action.run} type="button">
              <RotateCcw aria-hidden="true" size={13} />
              {notice.action.label}
            </button>
          ) : null}
          <button aria-label="通知を閉じる" onClick={() => setNotice(null)} type="button"><X aria-hidden="true" size={15} /></button>
        </div>
      ) : null}

      {validationOpen ? (
        <ValidationDialog
          issues={localIssues}
          onClose={() => setValidationOpen(false)}
          onSelectNode={(nodeId) => {
            setSelectedNodeId(nodeId);
            setSelectedEdgeId(null);
            setValidationOpen(false);
          }}
        />
      ) : null}

      {runConfirmOpen ? (
        <RunConfirmDialog
          busy={busyAction === "run"}
          onCancel={() => setRunConfirmOpen(false)}
          onConfirm={async () => {
            setRunConfirmOpen(false);
            await startRun();
          }}
          workflow={workflow}
        />
      ) : null}

      {deleteConfirmOpen ? (
        <ModalDialog ariaLabel="ワークフローの削除" onClose={() => setDeleteConfirmOpen(false)}>
          <div className="dialog-icon" data-tone="danger">
            <Trash2 aria-hidden="true" size={22} />
          </div>
          <p className="dialog-kicker">ワークフローの削除</p>
          <h2>「{workflow.name}」を削除しますか？</h2>
          <p className="dialog-lead">過去の実行記録は残りますが、ワークフロー本体の削除は取り消せません。</p>
          <div className="dialog-actions">
            <button className="button button--secondary" onClick={() => setDeleteConfirmOpen(false)} type="button">やめる</button>
            <button className="button button--danger" onClick={() => void deleteWorkflow()} type="button">削除する</button>
          </div>
        </ModalDialog>
      ) : null}

      {confirmAction ? (
        <ConfirmDialog
          action={confirmAction}
          busy={busyAction === confirmAction}
          onCancel={() => setConfirmAction(null)}
          onConfirm={async () => {
            const action = confirmAction;
            await controlRun(action);
            setConfirmAction(null);
          }}
        />
      ) : null}
    </main>
  );
}

function ExecutionControls({
  busyAction,
  canPause,
  canResume,
  canInterrupt,
  canStop,
  canRetry,
  onControl,
}: {
  busyAction: string | null;
  canPause: boolean;
  canResume: boolean;
  canInterrupt: boolean;
  canStop: boolean;
  canRetry: boolean;
  onControl: (action: ControlAction) => void;
}) {
  return (
    <div className="execution-controls">
      {canPause ? (
        <button className="button button--secondary" disabled={busyAction !== null} onClick={() => onControl("pause")} type="button">
          <Pause aria-hidden="true" size={15} /> 区切りで一時停止
        </button>
      ) : null}
      {canResume ? (
        <button className="button button--primary" disabled={busyAction !== null} onClick={() => onControl("resume")} type="button">
          <Play aria-hidden="true" size={15} /> 再開
        </button>
      ) : null}
      {canRetry ? (
        <button className="button button--primary" disabled={busyAction !== null} onClick={() => onControl("retry")} type="button">
          <RotateCcw aria-hidden="true" size={15} /> このボックスを再実行
        </button>
      ) : null}
      {canInterrupt ? (
        <button className="button button--warning" disabled={busyAction !== null} onClick={() => onControl("interrupt")} type="button">
          <CirclePause aria-hidden="true" size={15} /> 今すぐ中断
        </button>
      ) : null}
      {canStop ? (
        <button aria-label="実行を停止" className="icon-button icon-button--danger" disabled={busyAction !== null} onClick={() => onControl("stop")} title="実行を停止" type="button">
          <Square aria-hidden="true" size={15} />
        </button>
      ) : null}
    </div>
  );
}

function ValidationDialog({
  issues,
  onClose,
  onSelectNode,
}: {
  issues: ValidationIssue[];
  onClose: () => void;
  onSelectNode: (nodeId: string) => void;
}) {
  return (
    <ModalDialog ariaLabel="ワークフローのチェック" onClose={onClose}>
      <div className="dialog-icon" data-tone={issues.length === 0 ? "success" : "warning"}>
        {issues.length === 0 ? <CheckCircle2 aria-hidden="true" size={22} /> : <AlertTriangle aria-hidden="true" size={22} />}
      </div>
      <p className="dialog-kicker">チェック</p>
      <h2>{issues.length === 0 ? "実行できます" : `${issues.length}件の修正が必要です`}</h2>
      <p className="dialog-lead">
        {issues.length === 0
          ? "開始から終了までのつながりと、上限の設定を確認しました。"
          : "実行する前に、次の問題を直してください。"}
      </p>
      {issues.length > 0 ? (
        <ul className="validation-list">
          {issues.map((issue, index) => (
            <li key={`${issue.code}:${issue.nodeId ?? issue.edgeId ?? index}`}>
              <CircleAlert aria-hidden="true" size={15} />
              <div><strong>{issue.message}</strong></div>
              {issue.nodeId ? <button onClick={() => onSelectNode(issue.nodeId!)} type="button">開く</button> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="dialog-actions">
        <button className="button button--primary" onClick={onClose} type="button">閉じる</button>
      </div>
    </ModalDialog>
  );
}

function RunConfirmDialog({
  workflow,
  busy,
  onCancel,
  onConfirm,
}: {
  workflow: WorkflowDefinition;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  return (
    <ModalDialog ariaLabel="実行の確認" onClose={onCancel}>
      <div className="dialog-icon" data-tone="warning">
        <Play aria-hidden="true" size={22} />
      </div>
      <p className="dialog-kicker">実行の確認</p>
      <h2>この内容で実行しますか？</h2>
      <dl className="run-confirm-summary">
        <div><dt>エンジン</dt><dd>{workflowEngine(workflow) === "claude" ? "Claude Code（サブスクリプション枠を消費）" : "Codex"}</dd></div>
        <div><dt>モデル</dt><dd>{workflow.model}</dd></div>
        <div><dt>作業フォルダ</dt><dd><code>{workflow.cwd}</code></dd></div>
      </dl>
      <div className="dialog-warning">
        <ShieldAlert aria-hidden="true" size={16} />
        このフォルダのファイルを、確認なしで変更する場合があります。
      </div>
      <div className="dialog-actions">
        <button className="button button--secondary" disabled={busy} onClick={onCancel} type="button">やめる</button>
        <button className="button button--primary" disabled={busy} onClick={() => void onConfirm()} type="button">
          {busy ? "開始中…" : "実行する"}
        </button>
      </div>
    </ModalDialog>
  );
}

function ConfirmDialog({
  action,
  busy,
  onCancel,
  onConfirm,
}: {
  action: "interrupt" | "stop";
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const interrupt = action === "interrupt";
  return (
    <ModalDialog ariaLabel={interrupt ? "今すぐ中断の確認" : "停止の確認"} onClose={onCancel}>
      <div className="dialog-icon" data-tone="danger">
        {interrupt ? <CirclePause aria-hidden="true" size={22} /> : <CircleStop aria-hidden="true" size={22} />}
      </div>
      <p className="dialog-kicker">{interrupt ? "今すぐ中断" : "実行を停止"}</p>
      <h2>{interrupt ? "実行中の処理を中断しますか？" : "この実行を停止しますか？"}</h2>
      <p className="dialog-lead">
        {interrupt
          ? "すでに行われたファイル変更やコマンドは元に戻りません。中断後は「要復旧確認」になります。"
          : "これまでの記録は残ります。裏で動いているコマンドが終わったことは保証されません。"}
      </p>
      <div className="dialog-warning"><ShieldAlert aria-hidden="true" size={16} /> フルアクセスの影響は元に戻せません。</div>
      <div className="dialog-actions">
        <button className="button button--secondary" disabled={busy} onClick={onCancel} type="button">戻る</button>
        <button className="button button--danger" disabled={busy} onClick={() => void onConfirm()} type="button">
          {busy ? "送信中…" : interrupt ? "中断する" : "停止する"}
        </button>
      </div>
    </ModalDialog>
  );
}

function ModalDialog({
  ariaLabel,
  onClose,
  children,
}: {
  ariaLabel: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);
  return (
    <dialog aria-label={ariaLabel} className="modal-dialog" onCancel={(event) => { event.preventDefault(); onClose(); }} ref={dialogRef}>
      <button aria-label="ダイアログを閉じる" className="dialog-close" onClick={onClose} type="button"><X aria-hidden="true" size={17} /></button>
      {children}
    </dialog>
  );
}

function LoadingScreen() {
  return (
    <main className="system-screen" aria-busy="true">
      <span className="system-screen__mark"><RefreshCw aria-hidden="true" className="spin" size={22} /></span>
      <p className="panel-kicker">Emazna Loopy</p>
      <h1>準備しています</h1>
      <p>ワークフローと最新の実行を読み込んでいます。</p>
    </main>
  );
}

function ErrorScreen({ message, onRetry }: { message: string; onRetry: () => Promise<void> }) {
  return (
    <main className="system-screen">
      <span className="system-screen__mark system-screen__mark--error"><CircleAlert aria-hidden="true" size={22} /></span>
      <p className="panel-kicker">接続エラー</p>
      <h1>Loopyを開けませんでした</h1>
      <p>{message}</p>
      <button className="button button--primary" onClick={() => void onRetry()} type="button"><RefreshCw aria-hidden="true" size={15} /> 再試行</button>
    </main>
  );
}
