import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  InitializeResult,
  JsonValue as AdapterJsonValue,
  RequestId,
  ServerNotification,
  ServerRequest,
  StartThreadOptions,
  StartTurnOptions,
  ThreadStartResult,
  TurnCompletedParams,
  TurnStartResult,
  TurnStatus,
} from "@emazna/codex-app-server-adapter";

/** turn/start相当が確実に拒否された（プロセスを開始できなかった）ことを表す。 */
export class ClaudeTurnRejectedError extends Error {}

interface ActiveTurn {
  turnId: string;
  threadId: string;
  child: ChildProcessWithoutNullStreams;
  startedAt: number;
  interruptRequested: boolean;
  resultText: string | null;
  resultIsError: boolean;
  resultErrorMessage: string | null;
  sawResult: boolean;
  settled: boolean;
  resolve: (terminal: TurnCompletedParams) => void;
  terminal: Promise<TurnCompletedParams>;
  toolUses: Map<string, { name: string; command: string }>;
  stdoutBuffer: string;
}

/**
 * Claude Code CLIをヘッドレス（`claude --print`）で1ターン=1プロセスとして駆動する
 * エンジンクライアント。CodexAppServerClientと同じメソッド面を持ち、eventは
 * Codexプロトコル互換のnotification形式で流すため、runner本体・正規化・UIを共有できる。
 *
 * - セッション: 最初のターンで `--session-id <uuid>`、以降は `--resume <uuid>`（コンテキスト継続）
 * - 認証: ログイン済みClaude Code（サブスクリプション枠）。`CLAUDE_CODE_OAUTH_TOKEN` があれば引き継ぐ
 * - フルアクセス: `--dangerously-skip-permissions`（Codexの approval never / danger-full-access に相当）
 * - 中断/停止: プロセスツリーをkill
 * - raw thinkingは破棄し、本文・コマンド・ファイル変更だけをeventにする
 */
export class ClaudeCodeClient {
  private readonly bin: string;
  private version = "unknown";
  private readonly startedThreads = new Set<string>();
  private activeTurn: ActiveTurn | null = null;
  private notificationHandler: ((notification: ServerNotification) => void) | null = null;
  private stderrHandler: ((line: string) => void) | null = null;

  constructor(options?: { claudeBin?: string }) {
    this.bin = options?.claudeBin || process.env.LOOP_CANVAS_CLAUDE_BIN || "claude";
  }

  onNotification(handler: (notification: ServerNotification) => void): () => void {
    this.notificationHandler = handler;
    return () => {
      if (this.notificationHandler === handler) this.notificationHandler = null;
    };
  }

  onServerRequest(_handler: (request: ServerRequest) => void): () => void {
    // ヘッドレスのClaude Codeは対話的な確認要求を送らない。
    return () => undefined;
  }

  onStderr(handler: (line: string) => void): () => void {
    this.stderrHandler = handler;
    return () => {
      if (this.stderrHandler === handler) this.stderrHandler = null;
    };
  }

  onExit(_handler: (error: Error) => void): () => void {
    // ターンごとにプロセスが終了するのは正常動作なので、transport lossとしては扱わない。
    return () => undefined;
  }

  async start(): Promise<InitializeResult> {
    this.version = await this.readVersion();
    return {
      userAgent: `claude-code/${this.version}`,
      codexHome: process.env.CLAUDE_CONFIG_DIR ?? "",
      platformFamily: process.platform,
      platformOs: process.platform,
    };
  }

  async startThread(options: StartThreadOptions): Promise<ThreadStartResult> {
    const threadId = randomUUID();
    return this.threadResult(threadId, options);
  }

  async resumeThread(threadId: string, options: StartThreadOptions): Promise<ThreadStartResult> {
    // セッション実体は ~/.claude 配下に永続化されている。次のターンは --resume で継続する。
    this.startedThreads.add(threadId);
    return this.threadResult(threadId, options);
  }

  async startTurn(options: StartTurnOptions): Promise<TurnStartResult> {
    if (this.activeTurn && !this.activeTurn.settled) {
      throw new ClaudeTurnRejectedError("前のターンがまだ終わっていません。");
    }

    let prompt = options.prompt;
    if (options.outputSchema !== undefined) {
      prompt += [
        "",
        "",
        "回答は、次のJSON schemaに従うJSONだけを返してください。前後の説明文やコードフェンスは不要です。",
        JSON.stringify(options.outputSchema),
      ].join("\n");
    }

    const isFirstTurn = !this.startedThreads.has(options.threadId);
    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      options.model,
      "--dangerously-skip-permissions",
      ...(isFirstTurn ? ["--session-id", options.threadId] : ["--resume", options.threadId]),
    ];

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      LANG: process.env.LANG || "C.UTF-8",
      LC_ALL: process.env.LC_ALL || "C.UTF-8",
      PYTHONUTF8: "1",
    };

    // shellは使わない（引数連結の警告と注入面を避ける）。Windowsでも `claude.exe` はPATHから解決される。
    // npmの `claude.cmd` しか無い環境では LOOP_CANVAS_CLAUDE_BIN にフルパスを指定する。
    const child = spawn(this.bin, args, {
      cwd: options.cwd,
      env,
      windowsHide: true,
    });

    const turnId = randomUUID();
    let resolveTerminal!: (terminal: TurnCompletedParams) => void;
    const terminal = new Promise<TurnCompletedParams>((resolve) => {
      resolveTerminal = resolve;
    });
    const turn: ActiveTurn = {
      turnId,
      threadId: options.threadId,
      child,
      startedAt: Date.now(),
      interruptRequested: false,
      resultText: null,
      resultIsError: false,
      resultErrorMessage: null,
      sawResult: false,
      settled: false,
      resolve: resolveTerminal,
      terminal,
      toolUses: new Map(),
      stdoutBuffer: "",
    };
    this.activeTurn = turn;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new ClaudeTurnRejectedError("Claude Codeプロセスの起動がタイムアウトしました。"));
      }, Math.max(1_000, Math.min(options.requestTimeoutMs ?? 30_000, 30_000)));
      child.once("spawn", () => {
        clearTimeout(timer);
        resolve();
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        turn.settled = true;
        reject(new ClaudeTurnRejectedError(`Claude Codeを起動できませんでした: ${error.message}`));
      });
    });

    this.startedThreads.add(options.threadId);
    this.wireTurnStreams(turn);

    child.stdin.on("error", () => {
      // プロンプト書き込み前にプロセスが終了した場合のEPIPEは、close側の失敗処理に任せる。
    });
    child.stdin.write(prompt);
    child.stdin.end();

    return { turn: { id: turnId, status: "inProgress", error: null, durationMs: null } };
  }

  waitForTurn(_threadId: string, turnId: string, timeoutMs: number): Promise<TurnCompletedParams> {
    const turn = this.activeTurn;
    if (!turn || turn.turnId !== turnId) {
      return Promise.reject(new Error("対象のターンが見つかりません。"));
    }
    return new Promise<TurnCompletedParams>((resolve, reject) => {
      const timer = setTimeout(() => {
        stopProcessTree(turn.child.pid);
        reject(new Error("Claude Codeの応答がターンの上限時間内に完了しませんでした。"));
      }, Math.max(1, timeoutMs));
      turn.terminal.then((terminal) => {
        clearTimeout(timer);
        resolve(terminal);
      }, reject);
    });
  }

  async interrupt(_threadId: string, turnId: string): Promise<void> {
    const turn = this.activeTurn;
    if (!turn || turn.turnId !== turnId || turn.settled) return;
    turn.interruptRequested = true;
    stopProcessTree(turn.child.pid);
  }

  async replyServerRequest(_id: RequestId, _result: AdapterJsonValue): Promise<void> {
    throw new Error("Claude Codeエンジンには回答を返す対話要求がありません。");
  }

  async rejectServerRequest(_id: RequestId, _code: number, _message: string): Promise<void> {
    // 対話要求は発生しないため、何もしない。
  }

  async close(): Promise<void> {
    const turn = this.activeTurn;
    if (turn && !turn.settled) {
      turn.interruptRequested = true;
      stopProcessTree(turn.child.pid);
      await turn.terminal.catch(() => undefined);
    }
    this.activeTurn = null;
  }

  private threadResult(threadId: string, options: StartThreadOptions): ThreadStartResult {
    return {
      thread: {
        id: threadId,
        sessionId: threadId,
        forkedFromId: null,
        cliVersion: this.version,
        cwd: options.cwd,
        ephemeral: options.ephemeral ?? false,
      },
      model: options.model,
      modelProvider: "anthropic",
      serviceTier: null,
      cwd: options.cwd,
      instructionSources: [],
      // --dangerously-skip-permissions は「承認なし・フルアクセス」に相当するため、
      // Codexと同じ効果設定として報告し、runner側のドリフト検査を共通化する。
      approvalPolicy: "never",
      sandbox: { type: "dangerFullAccess", via: "claude --dangerously-skip-permissions" },
      reasoningEffort: options.reasoningEffort ?? null,
    };
  }

  private wireTurnStreams(turn: ActiveTurn): void {
    turn.child.stdout.on("data", (chunk: Buffer) => {
      turn.stdoutBuffer += chunk.toString("utf8");
      let newlineIndex = turn.stdoutBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = turn.stdoutBuffer.slice(0, newlineIndex).trim();
        turn.stdoutBuffer = turn.stdoutBuffer.slice(newlineIndex + 1);
        if (line) this.handleStreamLine(turn, line);
        newlineIndex = turn.stdoutBuffer.indexOf("\n");
      }
    });
    turn.child.stderr.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/u)) {
        if (line.trim()) this.stderrHandler?.(line);
      }
    });
    turn.child.on("close", (code) => {
      const leftover = turn.stdoutBuffer.trim();
      if (leftover) this.handleStreamLine(turn, leftover);
      this.settleTurn(turn, code);
    });
    turn.child.on("error", () => {
      this.settleTurn(turn, null);
    });
  }

  private settleTurn(turn: ActiveTurn, exitCode: number | null): void {
    if (turn.settled) return;
    turn.settled = true;

    let status: TurnStatus;
    let error: { message?: string } | null = null;
    if (turn.interruptRequested) {
      status = "interrupted";
    } else if (turn.sawResult && !turn.resultIsError) {
      status = "completed";
    } else {
      status = "failed";
      error = {
        message:
          turn.resultErrorMessage ??
          (exitCode !== null && exitCode !== 0
            ? `Claude Codeが終了コード${exitCode}で終了しました。`
            : "Claude Codeから結果を受け取れませんでした。"),
      };
    }

    const terminal: TurnCompletedParams = {
      threadId: turn.threadId,
      turn: {
        id: turn.turnId,
        status,
        error,
        durationMs: Date.now() - turn.startedAt,
      },
    };
    this.notify("turn/completed", { threadId: turn.threadId, turnId: turn.turnId, turn: terminal.turn as unknown as Record<string, unknown> });
    turn.resolve(terminal);
    if (this.activeTurn === turn) this.activeTurn = null;
  }

  private handleStreamLine(turn: ActiveTurn, line: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = event.type;
    if (type === "assistant") {
      const message = event.message as Record<string, unknown> | undefined;
      const content = Array.isArray(message?.content) ? (message?.content as Record<string, unknown>[]) : [];
      for (const block of content) {
        if (block.type === "text" && typeof block.text === "string" && block.text) {
          this.notify("item/agentMessage/delta", {
            threadId: turn.threadId,
            turnId: turn.turnId,
            delta: `${block.text}\n`,
          });
        } else if (block.type === "tool_use") {
          this.handleToolUse(turn, block);
        }
        // thinkingブロックはraw chain-of-thoughtとして破棄する。
      }
    } else if (type === "user") {
      const message = event.message as Record<string, unknown> | undefined;
      const content = Array.isArray(message?.content) ? (message?.content as Record<string, unknown>[]) : [];
      for (const block of content) {
        if (block.type === "tool_result") this.handleToolResult(turn, block);
      }
    } else if (type === "result") {
      turn.sawResult = true;
      turn.resultIsError = event.is_error === true;
      turn.resultText = typeof event.result === "string" ? event.result : "";
      if (turn.resultIsError) {
        turn.resultErrorMessage = typeof event.result === "string" && event.result
          ? event.result.slice(0, 2_000)
          : "Claude Codeがエラーを報告しました。";
      } else {
        this.notify("item/completed", {
          threadId: turn.threadId,
          turnId: turn.turnId,
          item: { type: "agentMessage", text: turn.resultText },
        });
      }
    }
    // type === "system"（init等）はUI向けの価値が薄いためeventにしない。
  }

  private handleToolUse(turn: ActiveTurn, block: Record<string, unknown>): void {
    const id = typeof block.id === "string" ? block.id : randomUUID();
    const name = typeof block.name === "string" ? block.name : "tool";
    const input = (block.input ?? {}) as Record<string, unknown>;

    if (name === "Bash") {
      const command = typeof input.command === "string" ? input.command : "";
      turn.toolUses.set(id, { name, command });
      this.notify("item/started", {
        threadId: turn.threadId,
        turnId: turn.turnId,
        item: { type: "commandExecution", id, command, cwd: "" },
      });
      return;
    }

    if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(name)) {
      const path = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : "";
      this.notify("item/completed", {
        threadId: turn.threadId,
        turnId: turn.turnId,
        item: { type: "fileChange", id, tool: name, path },
      });
      return;
    }
    // Read / Glob / Grep などの読み取り系ツールは記録しない（ログを本文とコマンド中心に保つ）。
  }

  private handleToolResult(turn: ActiveTurn, block: Record<string, unknown>): void {
    const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
    const used = turn.toolUses.get(toolUseId);
    if (!used || used.name !== "Bash") return;
    turn.toolUses.delete(toolUseId);

    let output = "";
    if (typeof block.content === "string") {
      output = block.content;
    } else if (Array.isArray(block.content)) {
      output = (block.content as Record<string, unknown>[])
        .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
        .join("\n");
    }
    const isError = block.is_error === true;
    this.notify("item/completed", {
      threadId: turn.threadId,
      turnId: turn.turnId,
      item: {
        type: "commandExecution",
        id: toolUseId,
        command: used.command,
        aggregatedOutput: output,
        exitCode: isError ? 1 : null,
        durationMs: null,
        status: isError ? "failed" : "completed",
      },
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.notificationHandler?.({ method, params });
  }

  private readVersion(): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, ["--version"], {
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        stopProcessTree(child.pid);
        reject(new Error("`claude --version` がタイムアウトしました。Claude Code CLIのインストールとログインを確認してください。"));
      }, 20_000);
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(new Error(`Claude Code CLIを起動できませんでした: ${error.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`\`claude --version\` が終了コード${code}で失敗しました: ${(stderr || stdout).slice(0, 300)}`));
          return;
        }
        resolve(stdout.trim() || "unknown");
      });
    });
  }
}

function stopProcessTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      const child = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      child.unref();
      return;
    } catch {
      // 下の直接killへフォールバックする。
    }
  }
  try {
    process.kill(pid);
  } catch {
    // すでに終了している場合は何もしない。
  }
}
