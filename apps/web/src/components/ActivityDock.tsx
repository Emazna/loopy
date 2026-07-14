"use client";

import type { RunEventRecord, RunSnapshot } from "@emazna/loop-runtime";
import {
  Activity,
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Clock3,
  Radio,
  Terminal,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ActivityItem, ActivityTab } from "./ui-types";
import { isRecord, textValue } from "./ui-types";

const TABS: Array<{ id: ActivityTab; label: string; icon: typeof Activity }> = [
  { id: "activity", label: "すべて", icon: Activity },
  { id: "agent", label: "エージェント", icon: Bot },
  { id: "commands", label: "コマンド", icon: Terminal },
];

const RUN_STATUS_TEXT: Record<string, string> = {
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

function humanizeType(type: string): string {
  return type
    .split(".")
    .map((part) => part.replaceAll("_", " "))
    .join(" · ");
}

function jsonDetail(payload: unknown): string {
  if (payload === null || payload === undefined) return "";
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

function clipped(value: string, max = 16_000): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n… 長いため以降は省略しています`;
}

function presentEvent(event: RunEventRecord): Omit<ActivityItem, "key" | "seq" | "type" | "nodeVisitId" | "createdAt"> {
  const payload = isRecord(event.payload) ? event.payload : {};
  const delta = textValue(payload.delta);
  const reason = textValue(payload.reason);
  const eventType = event.type;

  if (eventType === "agent.reasoning.summary.delta") {
    return { title: "思考の要約", detail: delta, tone: "info", category: "agent" };
  }
  if (eventType === "agent.message.delta" || eventType === "agent.message.completed") {
    return {
      title: "エージェントの発言",
      detail: clipped(delta || textValue(payload.text)),
      tone: "info",
      category: "agent",
    };
  }
  if (eventType === "agent.plan.updated") {
    return { title: "計画を更新", detail: jsonDetail(event.payload), tone: "info", category: "agent" };
  }
  if (eventType === "command.started") {
    return {
      title: "コマンド開始",
      detail: [textValue(payload.command), textValue(payload.cwd) ? `cwd: ${textValue(payload.cwd)}` : ""].filter(Boolean).join("\n"),
      tone: "neutral",
      category: "commands",
    };
  }
  if (eventType === "command.output.delta") {
    return { title: "コマンド出力", detail: delta, tone: "neutral", category: "commands" };
  }
  if (eventType === "command.completed") {
    const exitCode = payload.exitCode;
    const succeeded = exitCode === 0 || exitCode === null;
    return {
      title: succeeded ? "コマンド完了" : "コマンド失敗",
      detail: clipped([
        textValue(payload.command),
        textValue(payload.output),
        exitCode === null || exitCode === undefined ? "" : `exit ${String(exitCode)}`,
      ].filter(Boolean).join("\n")),
      tone: succeeded ? "success" : "danger",
      category: "commands",
    };
  }
  if (eventType.startsWith("file.")) {
    return {
      title: eventType === "file.diff.updated" ? "差分を更新" : "ファイルを変更",
      detail: clipped(textValue(payload.diff) || jsonDetail(event.payload)),
      tone: "info",
      category: "files",
    };
  }
  if (eventType === "route.selected") {
    return {
      title: "進む先を選択",
      detail: `${textValue(payload.label, "線")} → ${textValue(payload.target, "次のボックス")}`,
      tone: "success",
      category: "activity",
    };
  }
  if (eventType === "run.waiting_input") {
    return {
      title: "回答待ち",
      detail: "エージェントが回答を待っています。右側のパネルから回答してください。",
      tone: "warning",
      category: "activity",
    };
  }
  if (eventType === "control.failed" || eventType === "agent.error") {
    return {
      title: eventType === "control.failed" ? "操作が失敗しました" : "エージェントのエラー",
      detail: textValue(payload.message) || jsonDetail(event.payload),
      tone: "danger",
      category: "activity",
    };
  }
  if (eventType.startsWith("run.")) {
    const statusKey = eventType.slice(4);
    const statusText = RUN_STATUS_TEXT[statusKey] ?? statusKey.replaceAll("_", " ");
    const tone = eventType.includes("failed") || eventType.includes("recovery")
      ? "danger"
      : eventType.includes("completed")
        ? "success"
        : eventType.includes("paused") || eventType.includes("waiting")
          ? "warning"
          : "info";
    return { title: `実行: ${statusText}`, detail: reason, tone, category: "activity" };
  }
  if (eventType.startsWith("session.")) {
    return {
      title: humanizeType(eventType),
      detail: textValue(payload.threadId) || jsonDetail(event.payload),
      tone: "neutral",
      category: "activity",
    };
  }
  if (eventType === "appserver.connected") {
    return { title: "Codexに接続しました", detail: "プロトコルの初期化が完了しました。", tone: "success", category: "activity" };
  }

  return {
    title: humanizeType(eventType),
    detail: jsonDetail(event.payload),
    tone: eventType.includes("warning") ? "warning" : "neutral",
    category: "activity",
  };
}

function buildItems(events: RunEventRecord[]): ActivityItem[] {
  const items: ActivityItem[] = [];
  const coalescedTypes = new Set([
    "agent.reasoning.summary.delta",
    "agent.message.delta",
    "command.output.delta",
  ]);

  for (const event of events) {
    const presented = presentEvent(event);
    const previous = items.at(-1);
    if (
      previous &&
      coalescedTypes.has(event.type) &&
      previous.type === event.type &&
      previous.nodeVisitId === event.nodeVisitId
    ) {
      previous.detail = `${previous.detail}${presented.detail}`.slice(-16_000);
      previous.seq = event.seq;
      previous.createdAt = event.createdAt;
      previous.key = `${event.runId}:${event.seq}`;
      continue;
    }
    items.push({
      ...presented,
      key: `${event.runId}:${event.seq}`,
      seq: event.seq,
      type: event.type,
      nodeVisitId: event.nodeVisitId,
      createdAt: event.createdAt,
    });
  }
  return items.slice(-160);
}

function timeLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "--:--:--" : date.toLocaleTimeString("ja-JP", { hour12: false });
}

function durationLabel(snapshot: RunSnapshot): string {
  const start = snapshot.run.startedAt ? new Date(snapshot.run.startedAt).getTime() : null;
  if (!start) return "未開始";
  const end = snapshot.run.completedAt ? new Date(snapshot.run.completedAt).getTime() : Date.now();
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `${seconds}秒`;
  return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
}

export function ActivityDock({
  snapshot,
  streamStatus,
}: {
  snapshot: RunSnapshot | null;
  streamStatus: "idle" | "connecting" | "live" | "reconnecting";
}) {
  const [activeTab, setActiveTab] = useState<ActivityTab>("activity");
  const [stickToBottom, setStickToBottom] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const items = useMemo(() => buildItems(snapshot?.events ?? []), [snapshot?.events]);
  const visibleItems = activeTab === "activity"
    ? items
    : items.filter((item) => item.category === activeTab);
  const visitsById = useMemo(
    () => new Map((snapshot?.visits ?? []).map((visit) => [visit.id, visit])),
    [snapshot?.visits],
  );
  const nodesById = useMemo(
    () => new Map((snapshot?.definition.nodes ?? []).map((node) => [node.id, node])),
    [snapshot?.definition.nodes],
  );

  useEffect(() => {
    if (!stickToBottom || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [visibleItems.length, visibleItems.at(-1)?.detail, activeTab, stickToBottom]);

  function nodeLabel(nodeVisitId: string | null): string | null {
    if (!nodeVisitId) return null;
    const visit = visitsById.get(nodeVisitId);
    return visit ? nodesById.get(visit.nodeId)?.title ?? visit.nodeId : null;
  }

  return (
    <section aria-label="実行の記録" className="activity-dock panel-surface">
      <header className="activity-dock__header">
        <div className="activity-tabs" role="tablist" aria-label="記録の種類">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                aria-selected={activeTab === tab.id}
                className="activity-tab"
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                role="tab"
                type="button"
              >
                <Icon aria-hidden="true" size={14} />
                {tab.label}
              </button>
            );
          })}
        </div>
        <div className="run-strip" aria-live="polite">
          {snapshot ? (
            <>
              <span className="run-strip__status" data-status={snapshot.run.status}>
                <Radio aria-hidden="true" size={12} /> {RUN_STATUS_TEXT[snapshot.run.status] ?? snapshot.run.status}
              </span>
              <span><Clock3 aria-hidden="true" size={12} /> {durationLabel(snapshot)}</span>
              <span>{snapshot.run.visitCount}ステップ</span>
            </>
          ) : <span>まだ実行していません</span>}
          {snapshot ? (
            <span className="stream-status" data-state={streamStatus}>
              <span aria-hidden="true" />
              {streamStatus === "live"
                ? "ライブ"
                : streamStatus === "reconnecting"
                  ? "再接続中"
                  : streamStatus === "idle"
                    ? (["completed", "failed", "cancelled"].includes(snapshot.run.status) ? "記録" : "待機")
                    : "接続中"}
            </span>
          ) : null}
        </div>
      </header>

      <div
        className="activity-scroll"
        onScroll={(event) => {
          const target = event.currentTarget;
          setStickToBottom(target.scrollHeight - target.scrollTop - target.clientHeight < 48);
        }}
        ref={scrollRef}
        role="tabpanel"
        tabIndex={0}
      >
        {!snapshot ? (
          <div className="activity-empty">
            <Activity aria-hidden="true" size={22} />
            <p>実行を開始すると、Codexの動きがここへ流れます。</p>
          </div>
        ) : visibleItems.length === 0 ? (
          <div className="activity-empty">
            <CircleAlert aria-hidden="true" size={20} />
            <p>この種類の記録はまだありません。</p>
          </div>
        ) : (
          <ol className="activity-list">
            {visibleItems.map((item) => {
              const label = nodeLabel(item.nodeVisitId);
              return (
                <li className="activity-item" data-tone={item.tone} key={item.key}>
                  <span className="activity-item__marker" aria-hidden="true">
                    {item.tone === "success" ? <CheckCircle2 size={13} /> : item.tone === "danger" ? <CircleAlert size={13} /> : null}
                  </span>
                  <time dateTime={item.createdAt}>{timeLabel(item.createdAt)}</time>
                  <div className="activity-item__body">
                    <div className="activity-item__headline">
                      {label ? <span className="activity-item__node">{label}</span> : null}
                      <strong>{item.title}</strong>
                    </div>
                    {item.detail ? (
                      <pre data-code={item.category === "commands" || item.category === "files" || undefined}>{item.detail}</pre>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
      {!stickToBottom ? (
        <button
          className="jump-latest"
          onClick={() => {
            setStickToBottom(true);
            if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
          }}
          type="button"
        >
          <ChevronDown aria-hidden="true" size={14} /> 最新へ
        </button>
      ) : null}
    </section>
  );
}
