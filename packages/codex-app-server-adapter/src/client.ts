import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface, type Interface } from "node:readline";
import type {
  InitializeResult,
  JsonValue,
  RequestId,
  RpcError,
  ServerNotification,
  ServerRequest,
  StartThreadOptions,
  StartTurnOptions,
  ThreadStartResult,
  TurnCompletedParams,
  TurnStartResult,
} from "./protocol.js";

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface TurnWaiter {
  resolve: (value: TurnCompletedParams) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export interface AppServerClientOptions {
  codexBin?: string;
  codexHome?: string;
  requestTimeoutMs?: number;
  extraArgs?: string[];
  allowVersionMismatch?: boolean;
}

export class AppServerRpcError extends Error {
  constructor(
    message: string,
    readonly rpc: RpcError,
  ) {
    super(message);
    this.name = "AppServerRpcError";
  }
}

export class CodexAppServerClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private lines: Interface | null = null;
  private nextId = 1;
  private writeChain: Promise<void> = Promise.resolve();
  private pending = new Map<string, PendingRequest>();
  private turnWaiters = new Map<string, TurnWaiter>();
  private completedTurns = new Map<string, TurnCompletedParams>();
  private notificationListeners = new Set<(notification: ServerNotification) => void>();
  private serverRequestListeners = new Set<(request: ServerRequest) => void>();
  private stderrListeners = new Set<(line: string) => void>();
  private exitListeners = new Set<(error: Error) => void>();
  private knownThreads = new Set<string>();
  private started = false;
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private readonly requestTimeoutMs: number;

  initializeResult: InitializeResult | null = null;

  constructor(private readonly options: AppServerClientOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  onNotification(listener: (notification: ServerNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onServerRequest(listener: (request: ServerRequest) => void): () => void {
    this.serverRequestListeners.add(listener);
    return () => this.serverRequestListeners.delete(listener);
  }

  onStderr(listener: (line: string) => void): () => void {
    this.stderrListeners.add(listener);
    return () => this.stderrListeners.delete(listener);
  }

  onExit(listener: (error: Error) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  async start(): Promise<InitializeResult> {
    if (this.started && this.initializeResult) return this.initializeResult;
    if (this.process) throw new Error("Codex App Server is already starting.");
    this.closing = false;

    const codexBin = this.options.codexBin ?? process.env.LOOP_CANVAS_CODEX_BIN ?? "codex";
    this.assertCompatibleCli(codexBin);
    const env = this.buildChildEnvironment();
    const args = [
      "app-server",
      "--listen",
      "stdio://",
      "--disable",
      "plugins",
      "--disable",
      "apps",
      ...(this.options.extraArgs ?? []),
    ];
    this.process = spawn(codexBin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      windowsHide: true,
      shell: false,
    });

    this.process.once("error", (error) => this.handleExit(error));
    this.process.once("exit", (code, signal) => {
      if (!this.closing) {
        this.handleExit(new Error(`Codex App Server exited unexpectedly (code=${code}, signal=${signal}).`));
      }
    });

    this.lines = createInterface({ input: this.process.stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => this.handleLine(line));

    const stderr = createInterface({ input: this.process.stderr, crlfDelay: Infinity });
    stderr.on("line", (line) => {
      for (const listener of this.stderrListeners) listener(line);
    });

    const result = await this.request<InitializeResult>("initialize", {
      clientInfo: {
        name: "emazna_loop_canvas",
        title: "Emazna Loop Canvas",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    await this.notify("initialized");
    this.initializeResult = result;
    this.started = true;
    return result;
  }

  async startThread(options: StartThreadOptions): Promise<ThreadStartResult> {
    this.assertStarted();
    const result = await this.request<ThreadStartResult>("thread/start", {
      model: options.model,
      serviceTier: null,
      cwd: options.cwd,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      ephemeral: options.ephemeral ?? false,
    });
    this.knownThreads.add(result.thread.id);
    return result;
  }

  async resumeThread(threadId: string, options: StartThreadOptions): Promise<ThreadStartResult> {
    this.assertStarted();
    const result = await this.request<ThreadStartResult>("thread/resume", {
      threadId,
      model: options.model,
      serviceTier: null,
      cwd: options.cwd,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    this.knownThreads.add(result.thread.id);
    return result;
  }

  async startTurn(options: StartTurnOptions): Promise<TurnStartResult> {
    this.assertStarted();
    return this.request<TurnStartResult>("turn/start", {
      threadId: options.threadId,
      input: [{ type: "text", text: options.prompt, text_elements: [] }],
      cwd: options.cwd,
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
      model: options.model,
      effort: options.effort,
      summary: "concise",
      ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}),
    }, options.requestTimeoutMs);
  }

  async interrupt(threadId: string, turnId: string, timeoutMs = 5_000): Promise<void> {
    this.assertStarted();
    await this.request("turn/interrupt", { threadId, turnId }, timeoutMs);
  }

  async unsubscribe(threadId: string): Promise<void> {
    if (!this.started) return;
    try {
      await this.request("thread/unsubscribe", { threadId });
    } finally {
      this.knownThreads.delete(threadId);
    }
  }

  waitForTurn(threadId: string, turnId: string, timeoutMs: number): Promise<TurnCompletedParams> {
    const key = `${threadId}:${turnId}`;
    const completed = this.completedTurns.get(key);
    if (completed) {
      this.completedTurns.delete(key);
      return Promise.resolve(completed);
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.turnWaiters.delete(key);
        reject(new Error(`Timed out waiting for turn ${turnId}.`));
      }, timeoutMs);
      this.turnWaiters.set(key, { resolve, reject, timeout });
    });
  }

  async replyServerRequest(id: RequestId, result: JsonValue): Promise<void> {
    await this.write({ id, result });
  }

  async rejectServerRequest(id: RequestId, code: number, message: string): Promise<void> {
    await this.write({ id, error: { code, message } });
  }

  async request<T = unknown>(method: string, params?: unknown, timeoutMs = this.requestTimeoutMs): Promise<T> {
    if (!this.process || this.process.killed) throw new Error("Codex App Server is not running.");
    const id = this.nextId++;
    const key = String(id);
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`App Server request ${method} timed out.`));
      }, timeoutMs);
      this.pending.set(key, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
      void this.write({ method, id, ...(params === undefined ? {} : { params }) }).catch((error) => {
        clearTimeout(timeout);
        this.pending.delete(key);
        reject(error);
      });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  close(graceMs = 3_000): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const operation = this.closeInternal(graceMs).finally(() => {
      if (this.closePromise === operation) this.closePromise = null;
    });
    this.closePromise = operation;
    return operation;
  }

  private async closeInternal(graceMs: number): Promise<void> {
    this.closing = true;
    if (!this.process) {
      this.rejectOutstanding(new Error("Codex App Server client closed."));
      return;
    }
    const closeDeadline = Date.now() + Math.max(0, graceMs);
    for (const threadId of [...this.knownThreads]) {
      if (!(await this.settleBefore(this.unsubscribe(threadId), closeDeadline))) break;
    }

    const child = this.process;
    this.rejectOutstanding(new Error("Codex App Server client closed."));
    this.knownThreads.clear();
    child.stdin.end();
    const exited = await new Promise<boolean>((resolve) => {
      if (child.exitCode !== null) return resolve(true);
      const timer = setTimeout(() => resolve(false), Math.max(0, closeDeadline - Date.now()));
      child.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!exited && child.pid) {
      child.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 750));
      if (child.exitCode === null) await this.killProcessTree(child.pid);
    }
    this.lines?.close();
    this.process = null;
    this.started = false;
  }

  private async settleBefore(promise: Promise<unknown>, deadline: number): Promise<boolean> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      void promise.catch(() => undefined);
      return false;
    }
    let timer: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        promise.then(() => true, () => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), remaining);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private assertStarted(): void {
    if (!this.started || !this.process) throw new Error("Codex App Server handshake has not completed.");
  }

  private assertCompatibleCli(codexBin: string): void {
    if (this.options.allowVersionMismatch) return;
    const manifest = JSON.parse(
      readFileSync(new URL("../schema-manifest.json", import.meta.url), "utf8"),
    ) as { generatedWithCodexCli: string };
    const actual = execFileSync(codexBin, ["--version"], {
      encoding: "utf8",
      windowsHide: true,
    }).trim();
    if (actual !== manifest.generatedWithCodexCli) {
      throw new Error(
        `Codex CLI version mismatch: adapter=${manifest.generatedWithCodexCli}, actual=${actual}. Run npm run codex:generate and review the protocol before resuming runs.`,
      );
    }
  }

  private buildChildEnvironment(): NodeJS.ProcessEnv {
    const allowed = [
      "PATH",
      "Path",
      "PATHEXT",
      "SystemRoot",
      "WINDIR",
      "ComSpec",
      "TEMP",
      "TMP",
      "USERPROFILE",
      "HOME",
      "LOCALAPPDATA",
      "APPDATA",
      "PROGRAMDATA",
      "NUMBER_OF_PROCESSORS",
      "PROCESSOR_ARCHITECTURE",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "SSL_CERT_FILE",
    ];
    const env: NodeJS.ProcessEnv = {};
    for (const key of allowed) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    const codexHome = this.options.codexHome ?? process.env.LOOP_CANVAS_CODEX_HOME ?? process.env.CODEX_HOME;
    if (codexHome) env.CODEX_HOME = codexHome;
    return env;
  }

  private async write(message: unknown): Promise<void> {
    const task = this.writeChain.then(
      () =>
        new Promise<void>((resolve, reject) => {
          const stdin = this.process?.stdin;
          if (!stdin || stdin.destroyed) return reject(new Error("Codex App Server stdin is closed."));
          const line = `${JSON.stringify(message)}\n`;
          const onError = (error: Error) => {
            stdin.off("drain", onDrain);
            reject(error);
          };
          const onDrain = () => {
            stdin.off("error", onError);
            resolve();
          };
          stdin.once("error", onError);
          if (stdin.write(line)) {
            stdin.off("error", onError);
            resolve();
          } else {
            stdin.once("drain", onDrain);
          }
        }),
    );
    this.writeChain = task.catch(() => undefined);
    return task;
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      for (const listener of this.stderrListeners) listener(`Non-JSON stdout: ${line}`);
      return;
    }

    if (message.id !== undefined && !message.method) {
      const key = String(message.id);
      const pending = this.pending.get(key);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(key);
      if (message.error) {
        const rpc = message.error as RpcError;
        pending.reject(new AppServerRpcError(`${pending.method}: ${rpc.message}`, rpc));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method !== "string") return;
    if (message.id !== undefined) {
      const request = message as unknown as ServerRequest;
      if (this.serverRequestListeners.size === 0) {
        void this.rejectServerRequest(request.id, -32601, `Unsupported App Server request: ${request.method}`).catch((error) => {
          for (const listener of this.stderrListeners) listener(`Failed to reject ${request.method}: ${error instanceof Error ? error.message : String(error)}`);
        });
      } else {
        for (const listener of this.serverRequestListeners) listener(request);
      }
      return;
    }

    const notification = message as unknown as ServerNotification;
    if (notification.method === "turn/completed") {
      const params = notification.params as unknown as TurnCompletedParams;
      const key = `${params.threadId}:${params.turn.id}`;
      const waiter = this.turnWaiters.get(key);
      if (waiter) {
        clearTimeout(waiter.timeout);
        this.turnWaiters.delete(key);
        waiter.resolve(params);
      } else {
        this.completedTurns.set(key, params);
      }
    }
    for (const listener of this.notificationListeners) listener(notification);
  }

  private handleExit(error: Error): void {
    this.rejectOutstanding(error);
    for (const listener of this.exitListeners) listener(error);
  }

  private rejectOutstanding(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.turnWaiters.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.turnWaiters.clear();
  }

  private async killProcessTree(pid: number): Promise<void> {
    if (process.platform !== "win32") {
      this.process?.kill("SIGKILL");
      return;
    }
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        shell: false,
      });
      killer.once("exit", () => resolve());
      killer.once("error", () => resolve());
    });
  }
}
