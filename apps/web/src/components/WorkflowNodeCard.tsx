import type { NodeProps } from "@xyflow/react";
import { Handle, Position } from "@xyflow/react";
import { Check, Flag, GitBranch, Play, X } from "lucide-react";
import type { CanvasFlowNode } from "./ui-types";

const KIND_LABEL = {
  start: "開始",
  agent: "実行",
  decision: "分岐",
  end: "終了",
} as const;

const STATUS_LABEL = {
  scheduled: "実行予定",
  running: "実行中",
  succeeded: "完了",
  failed: "失敗",
  interrupted: "中断",
  outcome_unknown: "要確認",
} as const;

export function WorkflowNodeCard({ data, selected }: NodeProps<CanvasFlowNode>) {
  const { workflowNode, visitCount, visitStatus, isCurrent, isNext } = data;
  const statusLabel = isNext ? "次に実行" : visitStatus ? STATUS_LABEL[visitStatus] : "未実行";
  const accessibleLabel = [
    workflowNode.title,
    `${KIND_LABEL[workflowNode.kind]}ブロック`,
    isCurrent ? "実行中のブロック" : null,
    isNext ? "次に実行するブロック" : null,
    statusLabel,
    visitCount > 0 ? `実行 ${visitCount}回` : null,
  ]
    .filter(Boolean)
    .join("、");

  // 開始・終了: 縦長のオレンジ終端ブロック
  if (workflowNode.kind === "start" || workflowNode.kind === "end") {
    return (
      <article
        aria-label={accessibleLabel}
        className="workflow-node workflow-node--terminal"
        data-current={isCurrent || undefined}
        data-next={isNext || undefined}
        data-kind={workflowNode.kind}
        data-selected={selected || undefined}
        data-status={visitStatus ?? "idle"}
      >
        {workflowNode.kind === "end" ? (
          <Handle className="workflow-handle workflow-handle--target" position={Position.Left} type="target" />
        ) : null}
        <span className="workflow-node__terminal-icon">
          {workflowNode.kind === "start" ? <Play aria-hidden="true" size={15} /> : <Flag aria-hidden="true" size={15} />}
        </span>
        <strong className="workflow-node__terminal-title">{workflowNode.title}</strong>
        {workflowNode.kind === "start" ? (
          <Handle className="workflow-handle workflow-handle--source" position={Position.Right} type="source" />
        ) : null}
      </article>
    );
  }

  // 分岐: 丸いブロック（質問にCodexが答えて進む先を選ぶ）
  if (workflowNode.kind === "decision") {
    return (
      <article
        aria-label={accessibleLabel}
        className="workflow-node workflow-node--decision"
        data-current={isCurrent || undefined}
        data-next={isNext || undefined}
        data-kind="decision"
        data-selected={selected || undefined}
        data-status={visitStatus ?? "idle"}
      >
        <Handle className="workflow-handle workflow-handle--target" position={Position.Left} type="target" />
        <span className="workflow-node__decision-icon"><GitBranch aria-hidden="true" size={16} /></span>
        <strong className="workflow-node__decision-title">{workflowNode.title}</strong>
        <span className="workflow-node__decision-status" data-status={visitStatus ?? "idle"}>
          {statusLabel}
          {visitCount > 1 ? ` ×${visitCount}` : ""}
        </span>
        <Handle className="workflow-handle workflow-handle--source" position={Position.Right} type="source" />
      </article>
    );
  }

  // 実行: 再生ボタンのような矢印形。向き（右/左）を選べる。
  const direction = workflowNode.direction === "left" ? "left" : "right";
  return (
    <article
      aria-label={accessibleLabel}
      className="workflow-node workflow-node--agent"
      data-current={isCurrent || undefined}
      data-direction={direction}
      data-kind="agent"
      data-next={isNext || undefined}
      data-selected={selected || undefined}
      data-status={visitStatus ?? "idle"}
    >
      <Handle
        className="workflow-handle workflow-handle--target"
        position={direction === "right" ? Position.Left : Position.Right}
        type="target"
      />
      <div className="agent-shape">
        <div className="workflow-node__topline">
          <span className="workflow-node__kind">
            <Play aria-hidden="true" size={13} />
            {KIND_LABEL.agent}
          </span>
          {visitCount > 0 ? <span className="workflow-node__visits">× {visitCount}</span> : null}
        </div>
        <strong className="workflow-node__title">{workflowNode.title}</strong>
        <div className="workflow-node__footer">
          <span className="node-status" data-status={visitStatus ?? "idle"}>
            {visitStatus === "succeeded" ? <Check aria-hidden="true" size={12} /> : null}
            {visitStatus === "failed" || visitStatus === "outcome_unknown" ? (
              <X aria-hidden="true" size={12} />
            ) : null}
            {statusLabel}
          </span>
        </div>
      </div>
      <Handle
        className="workflow-handle workflow-handle--source"
        position={direction === "right" ? Position.Right : Position.Left}
        type="source"
      />
    </article>
  );
}
