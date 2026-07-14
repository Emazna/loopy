import type { JsonValue } from "@emazna/loop-runtime";
import type { ServerNotification } from "@emazna/codex-app-server-adapter";

export interface NormalizedEvent {
  type: string;
  payload: JsonValue;
  threadId: string | null;
  turnId: string | null;
}

function truncate(value: unknown, max = 100_000): string {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, max)}\n… truncated`;
}

function ids(params: Record<string, unknown>): { threadId: string | null; turnId: string | null } {
  return {
    threadId: typeof params.threadId === "string" ? params.threadId : null,
    turnId: typeof params.turnId === "string" ? params.turnId : null,
  };
}

export function normalizeNotification(notification: ServerNotification): NormalizedEvent[] {
  const params = notification.params ?? {};
  const correlation = ids(params);

  switch (notification.method) {
    case "item/reasoning/textDelta":
      return [];
    case "item/reasoning/summaryTextDelta":
      return [{ type: "agent.reasoning.summary.delta", payload: { delta: truncate(params.delta, 8_000) }, ...correlation }];
    case "item/reasoning/summaryPartAdded":
      return [{ type: "agent.reasoning.summary.part", payload: { summaryIndex: Number(params.summaryIndex ?? 0) }, ...correlation }];
    case "item/agentMessage/delta":
      return [{ type: "agent.message.delta", payload: { delta: truncate(params.delta, 16_000) }, ...correlation }];
    case "turn/plan/updated":
      return [{ type: "agent.plan.updated", payload: JSON.parse(JSON.stringify(params)) as JsonValue, ...correlation }];
    case "item/commandExecution/outputDelta":
      return [{ type: "command.output.delta", payload: { itemId: String(params.itemId ?? ""), delta: truncate(params.delta, 32_000) }, ...correlation }];
    case "turn/diff/updated":
      return [{ type: "file.diff.updated", payload: { diff: truncate(params.diff) }, ...correlation }];
    case "item/fileChange/patchUpdated":
      return [{ type: "file.patch.updated", payload: JSON.parse(JSON.stringify(params)) as JsonValue, ...correlation }];
    case "item/started": {
      const item = params.item as Record<string, unknown> | undefined;
      if (item?.type === "commandExecution") {
        return [{
          type: "command.started",
          payload: { itemId: String(item.id ?? ""), command: truncate(item.command, 16_000), cwd: String(item.cwd ?? "") },
          ...correlation,
        }];
      }
      return [{ type: "item.started", payload: { itemType: String(item?.type ?? "unknown"), itemId: String(item?.id ?? "") }, ...correlation }];
    }
    case "item/completed": {
      const item = params.item as Record<string, unknown> | undefined;
      if (item?.type === "commandExecution") {
        return [{
          type: "command.completed",
          payload: {
            itemId: String(item.id ?? ""),
            command: truncate(item.command, 16_000),
            output: truncate(item.aggregatedOutput, 64_000),
            exitCode: item.exitCode === null || item.exitCode === undefined ? null : Number(item.exitCode),
            durationMs: item.durationMs === null || item.durationMs === undefined ? null : Number(item.durationMs),
            status: String(item.status ?? ""),
          },
          ...correlation,
        }];
      }
      if (item?.type === "fileChange") {
        return [{ type: "file.change.completed", payload: JSON.parse(JSON.stringify(item)) as JsonValue, ...correlation }];
      }
      if (item?.type === "agentMessage") {
        return [{ type: "agent.message.completed", payload: { text: truncate(item.text, 100_000) }, ...correlation }];
      }
      return [{ type: "item.completed", payload: { itemType: String(item?.type ?? "unknown"), itemId: String(item?.id ?? "") }, ...correlation }];
    }
    case "turn/started":
      return [{ type: "turn.started", payload: JSON.parse(JSON.stringify(params)) as JsonValue, ...correlation }];
    case "turn/completed":
      return [{ type: "turn.completed", payload: JSON.parse(JSON.stringify(params)) as JsonValue, ...correlation }];
    case "error":
      return [{ type: "agent.error", payload: JSON.parse(JSON.stringify(params)) as JsonValue, ...correlation }];
    case "warning":
    case "configWarning":
    case "guardianWarning":
    case "deprecationNotice":
      return [{ type: "appserver.warning", payload: { method: notification.method, detail: JSON.parse(JSON.stringify(params)) as JsonValue }, ...correlation }];
    default:
      return [{
        type: "appserver.notification",
        payload: { method: notification.method, detail: truncate(JSON.stringify(params), 16_000) },
        ...correlation,
      }];
  }
}
