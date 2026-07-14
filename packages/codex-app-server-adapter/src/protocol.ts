export type RequestId = string | number;
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface RpcError {
  code: number;
  message: string;
  data?: JsonValue;
}

export interface ServerNotification {
  method: string;
  params?: Record<string, unknown>;
}

export interface ServerRequest extends ServerNotification {
  id: RequestId;
}

export interface InitializeResult {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

export interface ThreadInfo {
  id: string;
  sessionId: string;
  forkedFromId: string | null;
  cliVersion: string;
  cwd: string;
  ephemeral: boolean;
}

export interface ThreadStartResult {
  thread: ThreadInfo;
  model: string;
  modelProvider: string;
  serviceTier: string | null;
  cwd: string;
  instructionSources: string[];
  approvalPolicy: string;
  sandbox: JsonValue;
  reasoningEffort: string | null;
}

export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

export interface TurnInfo {
  id: string;
  status: TurnStatus;
  error: { message?: string } | null;
  durationMs: number | null;
  items?: unknown[];
}

export interface TurnStartResult {
  turn: TurnInfo;
}

export interface TurnCompletedParams {
  threadId: string;
  turn: TurnInfo;
}

export interface StartThreadOptions {
  model: string;
  cwd: string;
  reasoningEffort?: string;
  ephemeral?: boolean;
}

export interface StartTurnOptions {
  threadId: string;
  prompt: string;
  model: string;
  cwd: string;
  effort: string;
  outputSchema?: JsonValue;
  requestTimeoutMs?: number;
}
