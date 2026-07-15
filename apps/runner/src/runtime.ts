import { createRequire } from "node:module";
import type { AnySchema, ErrorObject, ValidateFunction } from "ajv";
import {
  AppServerRpcError,
  CodexAppServerClient,
  type RequestId,
  type ServerNotification,
  type ServerRequest,
  type ThreadStartResult,
} from "@emazna/codex-app-server-adapter";
import {
  decisionAgentNode,
  getNode,
  parseStructuredOutput,
  renderPrompt,
  selectOutgoingEdge,
  setStateAtPath,
  workflowEngine,
  type AgentNode,
  type JsonObject,
  type JsonValue,
  type RunRecord,
  type RunSessionRecord,
  type WorkflowDefinition,
  type WorkflowNode,
} from "@emazna/loop-runtime";
import { LoopStore } from "@emazna/loop-storage";
import { ClaudeCodeClient, ClaudeTurnRejectedError } from "./claude-client.js";
import { normalizeNotification } from "./normalizer.js";

/** runnerが利用するエンジンクライアントの共通面。Codex/Claudeの両実装が満たす。 */
type EngineClient = Pick<
  CodexAppServerClient,
  | "onNotification"
  | "onServerRequest"
  | "onStderr"
  | "onExit"
  | "start"
  | "close"
  | "startThread"
  | "resumeThread"
  | "startTurn"
  | "waitForTurn"
  | "interrupt"
  | "replyServerRequest"
  | "rejectServerRequest"
>;

class RecoveryRequiredError extends Error {}

const AjvConstructor = createRequire(import.meta.url)("ajv") as new (options?: Record<string, unknown>) => {
  compile(schema: AnySchema): ValidateFunction;
  errorsText(errors?: ErrorObject[] | null): string;
};

interface ActiveContext {
  runId: string;
  client: EngineClient;
  definition: WorkflowDefinition;
  visitId: string | null;
  nodeId: string | null;
  sessionId: string | null;
  threadId: string | null;
  turnId: string | null;
  turnStartInFlight: boolean;
  agentMessage: string;
  pauseRequested: boolean;
  interruptRequested: boolean;
  stopRequested: boolean;
  transportLost: boolean;
  loadedThreads: Set<string>;
}

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

function pathEqual(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function decodeRequestId(stored: string): RequestId {
  try {
    const parsed = JSON.parse(stored) as unknown;
    return typeof parsed === "number" || typeof parsed === "string" ? parsed : stored;
  } catch {
    return stored;
  }
}

export class LoopRunner {
  private pollTimer: NodeJS.Timeout | null = null;
  private tickBusy = false;
  private activePromise: Promise<void> | null = null;
  private active: ActiveContext | null = null;
  private shuttingDown = false;
  private readonly ajv = new AjvConstructor({ allErrors: true, strict: false });

  constructor(private readonly store: LoopStore) {}

  start(): void {
    this.store.recoverAbandonedRuns();
    this.store.recoverProcessingCommands();
    this.store.setMeta("runner_pid", String(process.pid));
    this.store.setMeta("runner_status", "online");
    this.pollTimer = setInterval(() => void this.tick(), 300);
    void this.tick();
  }

  async stop(): Promise<void> {
    this.shuttingDown = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.store.setMeta("runner_status", "stopping");
    if (this.active) {
      const run = this.store.getRun(this.active.runId);
      if (run && !["completed", "failed", "cancelled", "paused", "recovery_required"].includes(run.status)) {
        this.store.markRunRecoveryRequired(run.id, "実行中にランナーが停止しました。");
      }
      if (this.active.threadId && this.active.turnId) {
        await this.active.client.interrupt(this.active.threadId, this.active.turnId).catch(() => undefined);
      }
      await this.active.client.close();
    }
    await this.activePromise?.catch(() => undefined);
    this.store.setMeta("runner_status", "offline");
  }

  private async tick(): Promise<void> {
    if (this.tickBusy || this.shuttingDown) return;
    this.tickBusy = true;
    try {
      this.store.setMeta("runner_heartbeat", new Date().toISOString());
      await this.processControls();
      if (!this.activePromise) {
        const run = this.store.claimQueuedRun();
        if (run) {
          this.activePromise = this.executeRun(run)
            .catch((error) => {
              const current = this.store.getRun(run.id);
              if (current && !["completed", "failed", "cancelled", "recovery_required"].includes(current.status)) {
                this.store.setRunStatus(run.id, "failed", error instanceof Error ? error.message : String(error));
              }
            })
            .finally(() => {
              this.activePromise = null;
              this.active = null;
            });
        }
      }
    } finally {
      this.tickBusy = false;
    }
  }

  private async processControls(): Promise<void> {
    for (const command of this.store.takePendingCommands()) {
      let succeeded = true;
      try {
        const run = this.store.getRun(command.runId);
        if (!run) throw new Error("対象の実行が見つかりません。");
        const context = this.active?.runId === run.id ? this.active : null;
        if (["completed", "failed", "cancelled"].includes(run.status)) {
          throw new Error(`この実行はすでに終了しています（${run.status}）。`);
        }
        const activeVisit = run.currentNodeVisitId ? this.store.getVisit(run.currentNodeVisitId) : null;
        const activeTurnId = activeVisit?.status === "running" ? activeVisit.codexTurnId : null;

        switch (command.type) {
          case "pause":
            if (context && ["running", "waiting_input", "pause_requested"].includes(run.status)) {
              context.pauseRequested = true;
              this.store.setRunStatus(run.id, "pause_requested", "今のブロックの区切りで一時停止します。");
            } else if (run.status === "queued") {
              this.store.setRunStatus(run.id, "paused", "実行前に一時停止しました。");
            } else throw new Error(`今の状態（${run.status}）からは一時停止できません。`);
            break;
          case "resume":
            this.store.requeuePausedRun(run.id);
            break;
          case "interrupt":
            if (context?.turnStartInFlight) {
              context.interruptRequested = true;
              this.store.setRunStatus(run.id, "interrupting", "開始処理中に中断を受け付けました。");
              this.failActiveTransport(context);
              break;
            }
            if (!context || !context.threadId || !activeTurnId) {
              throw new Error("中断できる実行中の処理がありません。");
            }
            context.interruptRequested = true;
            this.store.setRunStatus(run.id, "interrupting", "今すぐ中断を受け付けました。");
            try {
              await context.client.interrupt(context.threadId, activeTurnId);
            } catch (error) {
              this.failActiveTransport(context);
              throw error;
            }
            this.scheduleInterruptEscalation(context, activeTurnId);
            break;
          case "stop":
            if (context && ["running", "pause_requested", "waiting_input", "interrupting"].includes(run.status)) {
              context.stopRequested = true;
              this.store.setRunStatus(run.id, "interrupting", "停止を受け付けました。");
              if (context.threadId && activeTurnId) {
                try {
                  await context.client.interrupt(context.threadId, activeTurnId);
                } catch (error) {
                  this.failActiveTransport(context);
                  throw error;
                }
                this.scheduleInterruptEscalation(context, activeTurnId);
              } else if (context.turnStartInFlight) {
                this.failActiveTransport(context);
              }
            } else {
              if (context) context.stopRequested = true;
              this.store.setRunStatus(run.id, "cancelled", "ユーザーが停止しました。");
            }
            break;
          case "retry":
            this.store.requeueRecoveryRun(run.id);
            break;
          case "skip": {
            const payload = command.payload as JsonObject;
            const target = typeof payload.targetNodeId === "string" ? payload.targetNodeId : undefined;
            if (!target) throw new Error("skip requires targetNodeId.");
            if (!getNode(this.store.getDefinitionForRun(run.id), target)) {
              throw new Error(`skip target ${target} is not in the immutable workflow version.`);
            }
            this.store.requeueRecoveryRun(run.id, target);
            break;
          }
          case "answer_input": {
            if (!context) throw new Error("Codexとの接続が切れています。");
            if (!["waiting_input", "pause_requested"].includes(run.status)) {
              throw new Error(`Run is not waiting for input (${run.status}).`);
            }
            const payload = command.payload as JsonObject;
            const interactionId = String(payload.interactionId ?? "");
            const answers = payload.answers as JsonValue;
            const interaction = this.store.getInteraction(interactionId);
            if (!interaction || interaction.status !== "pending") throw new Error("回答待ちの質問が見つかりません。");
            if (interaction.runId !== run.id) throw new Error("この実行の質問ではありません。");
            await context.client.replyServerRequest(decodeRequestId(interaction.requestId), { answers } as JsonValue);
            this.store.answerInteraction(interactionId, answers);
            this.store.setRunStatus(run.id, context.pauseRequested ? "pause_requested" : "running", null);
            break;
          }
        }
      } catch (error) {
        succeeded = false;
        if (this.store.getRun(command.runId)) {
          this.store.appendEvent(command.runId, "control.failed", {
            action: command.type,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        this.store.finishCommand(command.id, succeeded);
      }
    }
  }

  private async executeRun(initialRun: RunRecord): Promise<void> {
    const definition = this.store.getDefinitionForRun(initialRun.id);
    // ワークフローの設定に応じて、Codex App Server か Claude Code CLI を使い分ける。
    const client: EngineClient = workflowEngine(definition) === "claude"
      ? new ClaudeCodeClient({ claudeBin: process.env.LOOP_CANVAS_CLAUDE_BIN })
      : new CodexAppServerClient({
          codexBin: process.env.LOOP_CANVAS_CODEX_BIN,
          codexHome: process.env.LOOP_CANVAS_CODEX_HOME,
        });
    const context: ActiveContext = {
      runId: initialRun.id,
      client,
      definition,
      visitId: null,
      nodeId: null,
      sessionId: initialRun.activeSessionId,
      threadId: null,
      turnId: null,
      turnStartInFlight: false,
      agentMessage: "",
      pauseRequested: false,
      interruptRequested: false,
      stopRequested: false,
      transportLost: false,
      loadedThreads: new Set(),
    };
    this.active = context;

    client.onNotification((notification) => {
      try {
        this.handleNotification(context, notification);
      } catch {
        this.failActiveTransport(context);
      }
    });
    client.onServerRequest((request) => {
      void this.handleServerRequest(context, request).catch((error) => {
        try {
          this.store.appendEvent(
            context.runId,
            "server_request.reply_failed",
            { method: request.method, message: error instanceof Error ? error.message : String(error) },
            context.visitId,
          );
        } catch {
          // The transport is failed below even if the audit store is unavailable.
        }
        this.failActiveTransport(context);
      });
    });
    client.onStderr((line) => {
      try {
        this.store.appendEvent(context.runId, "appserver.stderr", { line: line.slice(0, 4_000) }, context.visitId);
      } catch {
        this.failActiveTransport(context);
      }
    });
    client.onExit(() => {
      if (!this.shuttingDown) context.transportLost = true;
    });

    try {
      const initialize = await client.start();
      this.store.setMeta("codex_status", "connected");
      this.store.setMeta("codex_home", initialize.codexHome);
      this.store.appendEvent(initialRun.id, "appserver.connected", asJson(initialize));
      const startedAtMs = Date.parse(initialRun.startedAt ?? initialRun.createdAt);
      // maxRunMinutes 未設定なら実行時間の上限なし（締切は無限遠に置く）。
      const runDeadlineAt = definition.limits.maxRunMinutes
        ? startedAtMs + definition.limits.maxRunMinutes * 60_000
        : Number.POSITIVE_INFINITY;

      while (!this.shuttingDown) {
        const run = this.store.getRun(initialRun.id);
        if (!run) return;
        if (["completed", "failed", "cancelled", "paused", "recovery_required"].includes(run.status)) return;
        if (context.stopRequested) {
          this.store.setRunStatus(run.id, "cancelled", "次のブロックが始まる前にユーザーが停止しました。");
          return;
        }
        if (run.status === "pause_requested" && !run.currentNodeVisitId) {
          this.store.setRunStatus(run.id, "paused", "ブロックの区切りで一時停止しました。");
          return;
        }
        if (Date.now() >= runDeadlineAt) {
          this.store.setRunStatus(run.id, "failed", `実行時間が上限（${definition.limits.maxRunMinutes}分）に達しました。`);
          return;
        }
        if (run.visitCount >= definition.limits.maxNodeVisits) {
          this.store.setRunStatus(run.id, "failed", `合計ステップ数が上限（${definition.limits.maxNodeVisits}）に達しました。`);
          return;
        }
        if (!run.nextNodeId) {
          this.store.setRunStatus(run.id, "failed", "次に進むブロックがありません。");
          return;
        }
        const node = getNode(definition, run.nextNodeId);
        if (!node) {
          this.store.setRunStatus(run.id, "failed", `ブロック ${run.nextNodeId} が見つかりません（保存済みのワークフローに存在しません）。`);
          return;
        }
        if (this.store.countVisitsForNode(run.id, node.id) >= definition.limits.maxVisitsPerNode) {
          this.store.setRunStatus(run.id, "failed", `「${node.title}」の実行回数が上限（${definition.limits.maxVisitsPerNode}回）に達しました。`);
          return;
        }

        if (node.kind === "agent") await this.executeAgentNode(context, run, node, runDeadlineAt);
        // 分岐はCodexへの質問1ターンとして実行し、回答（基準ラベル）で進む先を決める。
        else if (node.kind === "decision") await this.executeAgentNode(context, run, decisionAgentNode(definition, node), runDeadlineAt);
        else await this.executeControlNode(context, run, node);
      }
    } catch (error) {
      const run = this.store.getRun(initialRun.id);
      if (!this.shuttingDown && run && !["completed", "failed", "cancelled", "recovery_required"].includes(run.status)) {
        const status = error instanceof RecoveryRequiredError || context.transportLost ? "recovery_required" : "failed";
        const reason = error instanceof Error ? error.message : String(error);
        if (status === "recovery_required" || run.currentNodeVisitId) {
          this.store.markRunRecoveryRequired(run.id, reason);
        } else {
          this.store.setRunStatus(run.id, status, reason);
        }
      }
    } finally {
      if (this.store.getRun(initialRun.id)?.status === "waiting_input") {
        this.store.markRunRecoveryRequired(initialRun.id, "回答待ちの間にCodexとの接続が閉じられました。");
      }
      // A turn can leave waiting_input via interrupt/stop before the App Server
      // connection closes. Any still-pending request belongs to that connection
      // and can no longer be answered after this point.
      this.store.markConnectionInteractionsLost(initialRun.id);
      await client.close();
      this.store.setMeta("codex_status", "disconnected");
    }
  }

  private async executeControlNode(context: ActiveContext, run: RunRecord, node: WorkflowNode): Promise<void> {
    const visit = this.store.startNodeVisit(run.id, node.id, run.activeSessionId, null);
    context.visitId = visit.id;
    context.nodeId = node.id;

    if (node.kind === "end") {
      this.store.completeVisit({
        runId: run.id,
        visitId: visit.id,
        visitStatus: "succeeded",
        state: run.state,
        nextNodeId: null,
        activeSessionId: run.activeSessionId,
        runStatus: context.stopRequested ? "cancelled" : "completed",
        terminationReason: context.stopRequested ? "ユーザーが停止しました。" : "終了ブロックに到達しました。",
      });
      return;
    }

    const edge = selectOutgoingEdge(context.definition, node.id, run.state);
    if (!edge) {
      this.store.completeVisit({
        runId: run.id,
        visitId: visit.id,
        visitStatus: "failed",
        error: { message: `「${node.title}」から進める線が見つかりませんでした。` },
        state: run.state,
        nextNodeId: null,
        activeSessionId: run.activeSessionId,
        runStatus: "failed",
        terminationReason: `「${node.title}」から進める線が見つかりませんでした。`,
      });
      return;
    }

    this.store.appendEvent(run.id, "route.selected", { edgeId: edge.id, label: edge.label, target: edge.target }, visit.id);
    const latest = this.store.getRun(run.id)!;
    this.store.completeVisit({
      runId: run.id,
      visitId: visit.id,
      visitStatus: "succeeded",
      output: { edgeId: edge.id, label: edge.label },
      selectedEdgeId: edge.id,
      state: run.state,
      nextNodeId: edge.target,
      activeSessionId: run.activeSessionId,
      runStatus: latest.status === "pause_requested" || context.pauseRequested ? "paused" : "running",
      terminationReason: latest.status === "pause_requested" || context.pauseRequested ? "一時停止を受け付けました。" : null,
    });
  }

  private async executeAgentNode(
    context: ActiveContext,
    run: RunRecord,
    node: AgentNode,
    runDeadlineAt: number,
  ): Promise<void> {
    const prompt = renderPrompt(node.prompt, run.state);
    const visit = this.store.startNodeVisit(run.id, node.id, run.activeSessionId, prompt);
    context.visitId = visit.id;
    context.nodeId = node.id;
    context.turnId = null;
    context.agentMessage = "";

    if (context.stopRequested) {
      this.cancelVisit(run, visit.id, run.activeSessionId, "処理が始まる前に停止しました。");
      return;
    }

    let session: RunSessionRecord;
    try {
      session = await this.selectSession(context, run, node, visit.id);
    } catch (error) {
      if (this.shuttingDown) return;
      if (context.stopRequested) {
        this.cancelVisit(run, visit.id, run.activeSessionId, "処理が始まる前に停止しました。");
        return;
      }
      const status = run.activeSessionId && node.sessionPolicy === "continue" ? "recovery_required" : "failed";
      this.store.completeVisit({
        runId: run.id,
        visitId: visit.id,
        visitStatus: "failed",
        error: { message: error instanceof Error ? error.message : String(error) },
        state: run.state,
        nextNodeId: status === "recovery_required" ? node.id : null,
        activeSessionId: run.activeSessionId,
        runStatus: status,
        terminationReason: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (this.shuttingDown) return;
    if (context.stopRequested) {
      this.cancelVisit(run, visit.id, session.id, "処理が始まる前に停止しました。");
      return;
    }
    if (Date.now() >= runDeadlineAt) {
      this.store.completeVisit({
        runId: run.id,
        visitId: visit.id,
        visitStatus: "failed",
        error: { message: `処理を始める前に実行時間が上限（${context.definition.limits.maxRunMinutes}分）に達しました。` },
        state: this.store.getRun(run.id)?.state ?? run.state,
        nextNodeId: null,
        activeSessionId: session.id,
        runStatus: "failed",
        terminationReason: `実行時間が上限（${context.definition.limits.maxRunMinutes}分）に達しました。`,
      });
      return;
    }

    context.sessionId = session.id;
    context.threadId = session.codexThreadId;
    const turnStartRequestedAt = Date.now();
    const turnRequestTimeoutMs = Math.max(
      1,
      Math.min(
        30_000,
        runDeadlineAt - turnStartRequestedAt,
        context.definition.limits.turnTimeoutMinutes * 60_000,
      ),
    );
    let turn;
    context.turnStartInFlight = true;
    try {
      turn = await context.client.startTurn({
        threadId: session.codexThreadId,
        prompt,
        model: context.definition.model,
        cwd: context.definition.cwd,
        effort: context.definition.reasoningEffort,
        outputSchema: node.outputSchema as JsonValue | undefined,
        requestTimeoutMs: turnRequestTimeoutMs,
      });
    } catch (error) {
      if (this.shuttingDown) return;
      const definitelyRejected = error instanceof AppServerRpcError || error instanceof ClaudeTurnRejectedError;
      if (context.stopRequested && definitelyRejected) {
        this.cancelVisit(run, visit.id, session.id, "開始が受け付けられる前に停止しました。");
        return;
      }
      this.store.completeVisit({
        runId: run.id,
        visitId: visit.id,
        visitStatus: definitelyRejected ? "failed" : "outcome_unknown",
        error: { message: error instanceof Error ? error.message : String(error) },
        state: run.state,
        nextNodeId: definitelyRejected ? null : node.id,
        activeSessionId: session.id,
        runStatus: definitelyRejected ? "failed" : "recovery_required",
        terminationReason: definitelyRejected
          ? "エンジンが処理の開始を拒否しました。"
          : "処理を開始できたか不明です。自動での再実行は行いません。",
      });
      return;
    } finally {
      context.turnStartInFlight = false;
    }
    context.turnId = turn.turn.id;
    this.store.attachTurn(visit.id, turn.turn.id, session.id);
    this.store.appendEvent(run.id, "turn.started", { turnId: turn.turn.id }, visit.id, session.codexThreadId, turn.turn.id);

    if ((context.interruptRequested || context.stopRequested) && context.threadId && context.turnId) {
      await context.client.interrupt(context.threadId, context.turnId);
    }

    let terminal;
    try {
      const remainingRunMs = Math.max(1, runDeadlineAt - Date.now());
      const turnDeadlineAt = turnStartRequestedAt + context.definition.limits.turnTimeoutMinutes * 60_000;
      const remainingTurnMs = Math.max(1, turnDeadlineAt - Date.now());
      terminal = await context.client.waitForTurn(
        session.codexThreadId,
        turn.turn.id,
        Math.min(remainingTurnMs, remainingRunMs),
      );
    } catch (error) {
      if (this.shuttingDown) return;
      if (context.threadId && context.turnId && !context.transportLost) {
        await context.client.interrupt(context.threadId, context.turnId).catch(() => undefined);
      }
      this.store.completeVisit({
        runId: run.id,
        visitId: visit.id,
        visitStatus: "outcome_unknown",
        outputText: context.agentMessage || null,
        error: { message: error instanceof Error ? error.message : String(error) },
        state: run.state,
        nextNodeId: node.id,
        activeSessionId: session.id,
        runStatus: "recovery_required",
        terminationReason: context.transportLost
          ? "処理の途中でCodexとの接続が失われました。"
          : context.stopRequested
            ? "停止しましたが、処理の結果が不明です。自動での再実行は行いません。"
          : Date.now() >= runDeadlineAt
            ? `実行時間が上限（${context.definition.limits.maxRunMinutes}分）に達したため中断しました。自動での再実行は行いません。`
            : "処理の結果が不明です。",
      });
      return;
    }

    if (this.shuttingDown) return;

    const status = terminal.turn.status;
    if (status !== "completed" || context.interruptRequested || context.stopRequested) {
      this.store.completeVisit({
        runId: run.id,
        visitId: visit.id,
        visitStatus: context.stopRequested ? "interrupted" : status === "interrupted" ? "interrupted" : "outcome_unknown",
        outputText: context.agentMessage || null,
        error: terminal.turn.error ? asJson(terminal.turn.error) : null,
        state: run.state,
        nextNodeId: context.stopRequested ? null : node.id,
        activeSessionId: session.id,
        runStatus: context.stopRequested ? "cancelled" : status === "failed" && !context.interruptRequested ? "failed" : "recovery_required",
        terminationReason: context.stopRequested
          ? "ユーザーが停止しました。裏で動いていたコマンドは残っている場合があります。"
          : status === "failed" && !context.interruptRequested
            ? terminal.turn.error?.message ?? "Codexの処理が失敗しました。"
            : "処理を中断しました。自動での再実行は行いません。",
      });
      return;
    }

    let output: JsonValue = context.agentMessage;
    if (node.outputSchema) {
      try {
        output = parseStructuredOutput(context.agentMessage);
        const validate = this.ajv.compile(node.outputSchema);
        if (!validate(output)) throw new Error(this.ajv.errorsText(validate.errors));
      } catch (error) {
        this.store.completeVisit({
          runId: run.id,
          visitId: visit.id,
          visitStatus: "failed",
          outputText: context.agentMessage || null,
          error: { message: `構造化出力の検証に失敗しました: ${error instanceof Error ? error.message : String(error)}` },
          state: run.state,
          nextNodeId: null,
          activeSessionId: session.id,
          runStatus: "failed",
          terminationReason: "構造化出力が不正でした。自動での再実行は行いません。",
        });
        return;
      }
    }

    const state = setStateAtPath(run.state, node.outputKey, output);
    const edge = selectOutgoingEdge(context.definition, node.id, state);
    if (!edge) {
      this.store.completeVisit({
        runId: run.id,
        visitId: visit.id,
        visitStatus: "failed",
        outputText: context.agentMessage,
        output,
        error: { message: `「${node.title}」から進む線を1本に決められませんでした。` },
        state,
        nextNodeId: null,
        activeSessionId: session.id,
        runStatus: "failed",
        terminationReason: `「${node.title}」から進む線を1本に決められませんでした。`,
      });
      return;
    }

    this.store.appendEvent(run.id, "route.selected", { edgeId: edge.id, label: edge.label, target: edge.target }, visit.id, session.codexThreadId, turn.turn.id);
    const latest = this.store.getRun(run.id)!;
    const pause = latest.status === "pause_requested" || context.pauseRequested;
    this.store.completeVisit({
      runId: run.id,
      visitId: visit.id,
      visitStatus: "succeeded",
      outputText: context.agentMessage,
      output,
      selectedEdgeId: edge.id,
      state,
      nextNodeId: edge.target,
      activeSessionId: session.id,
      runStatus: pause ? "paused" : "running",
      terminationReason: pause ? "一時停止を受け付けました。" : null,
    });
  }

  private cancelVisit(
    run: RunRecord,
    visitId: string,
    activeSessionId: string | null,
    reason: string,
  ): void {
    const latest = this.store.getRun(run.id) ?? run;
    this.store.completeVisit({
      runId: run.id,
      visitId,
      visitStatus: "interrupted",
      error: { message: reason },
      state: latest.state,
      nextNodeId: null,
      activeSessionId,
      runStatus: "cancelled",
      terminationReason: reason,
    });
  }

  private async selectSession(
    context: ActiveContext,
    run: RunRecord,
    node: AgentNode,
    visitId: string,
  ): Promise<RunSessionRecord> {
    let existing = run.activeSessionId ? this.store.getSession(run.activeSessionId) : null;
    if (node.sessionPolicy === "fresh" || !existing) {
      if (existing) this.store.setSessionStatus(existing.id, "inactive");
      const result = await context.client.startThread({
        model: context.definition.model,
        cwd: context.definition.cwd,
        reasoningEffort: context.definition.reasoningEffort,
        ephemeral: false,
      });
      this.assertEffectiveSettings(context.definition, result);
      const session = this.store.createSession({
        runId: run.id,
        visitId,
        thread: result.thread,
        effective: {
          model: result.model,
          cwd: result.cwd,
          approvalPolicy: result.approvalPolicy,
          sandbox: result.sandbox,
          reasoningEffort: result.reasoningEffort,
          instructionSources: result.instructionSources,
        },
      });
      context.loadedThreads.add(session.codexThreadId);
      this.store.appendEvent(run.id, "session.started", {
        sessionId: session.id,
        threadId: session.codexThreadId,
        policy: node.sessionPolicy,
        requestedModel: context.definition.model,
        effectiveModel: result.model,
      }, visitId, session.codexThreadId);
      return session;
    }

    if (!context.loadedThreads.has(existing.codexThreadId)) {
      let result: ThreadStartResult;
      try {
        result = await context.client.resumeThread(existing.codexThreadId, {
          model: context.definition.model,
          cwd: context.definition.cwd,
          reasoningEffort: context.definition.reasoningEffort,
        });
      } catch (error) {
        throw new RecoveryRequiredError(`Could not resume Codex thread ${existing.codexThreadId}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (result.thread.cliVersion !== existing.cliVersion) {
        throw new RecoveryRequiredError(`Codex CLI version changed from ${existing.cliVersion} to ${result.thread.cliVersion}.`);
      }
      this.assertEffectiveSettings(context.definition, result);
      context.loadedThreads.add(existing.codexThreadId);
      this.store.appendEvent(run.id, "session.resumed", {
        sessionId: existing.id,
        threadId: existing.codexThreadId,
      }, visitId, existing.codexThreadId);
    } else {
      this.store.appendEvent(run.id, "session.continued", {
        sessionId: existing.id,
        threadId: existing.codexThreadId,
      }, visitId, existing.codexThreadId);
    }
    return existing;
  }

  private assertEffectiveSettings(definition: WorkflowDefinition, result: ThreadStartResult): void {
    const sandbox = result.sandbox as { type?: string } | null;
    if (result.model !== definition.model) {
      throw new Error(`Model drift: requested ${definition.model}, effective ${result.model}.`);
    }
    if (!pathEqual(result.cwd, definition.cwd)) {
      throw new Error(`CWD drift: requested ${definition.cwd}, effective ${result.cwd}.`);
    }
    if (result.approvalPolicy !== "never") {
      throw new Error(`Approval policy drift: expected never, effective ${result.approvalPolicy}.`);
    }
    if (sandbox?.type !== "dangerFullAccess") {
      throw new Error(`Sandbox drift: expected dangerFullAccess, effective ${JSON.stringify(result.sandbox)}.`);
    }
  }

  private handleNotification(context: ActiveContext, notification: ServerNotification): void {
    if (notification.method === "item/completed") {
      const item = notification.params?.item as Record<string, unknown> | undefined;
      if (item?.type === "agentMessage" && typeof item.text === "string") context.agentMessage = item.text;
    } else if (notification.method === "item/agentMessage/delta") {
      const delta = notification.params?.delta;
      if (typeof delta === "string") context.agentMessage += delta;
    }

    for (const event of normalizeNotification(notification)) {
      this.store.appendEvent(
        context.runId,
        event.type,
        event.payload,
        context.visitId,
        event.threadId,
        event.turnId,
      );
    }
  }

  private failActiveTransport(context: ActiveContext): void {
    if (this.shuttingDown || context.transportLost) return;
    context.transportLost = true;
    void context.client.close().catch(() => undefined);
  }

  private scheduleInterruptEscalation(context: ActiveContext, turnId: string): void {
    const timer = setTimeout(() => {
      try {
        const run = this.store.getRun(context.runId);
        const visit = run?.currentNodeVisitId ? this.store.getVisit(run.currentNodeVisitId) : null;
        if (
          this.active === context &&
          run?.status === "interrupting" &&
          visit?.status === "running" &&
          visit.codexTurnId === turnId
        ) {
          this.failActiveTransport(context);
        }
      } catch {
        // The runner/store may already be shutting down.
      }
    }, 5_000);
    timer.unref();
  }

  private async handleServerRequest(context: ActiveContext, request: ServerRequest): Promise<void> {
    if (!context.visitId) {
      await context.client.rejectServerRequest(request.id, -32601, "この要求を処理できる実行中のブロックがありません。");
      return;
    }
    if (request.method === "item/tool/requestUserInput") {
      this.store.createPendingInteraction(
        context.runId,
        context.visitId,
        JSON.stringify(request.id),
        request.method,
        asJson(request.params ?? {}),
      );
      return;
    }
    if (request.method === "item/commandExecution/requestApproval" || request.method === "item/fileChange/requestApproval") {
      await context.client.replyServerRequest(request.id, { decision: "decline" });
      this.store.appendEvent(context.runId, "server_request.declined", { method: request.method }, context.visitId);
      return;
    }
    await context.client.rejectServerRequest(request.id, -32601, `Loop Canvas does not support ${request.method}.`);
    this.store.appendEvent(context.runId, "server_request.rejected", { method: request.method }, context.visitId);
  }
}
