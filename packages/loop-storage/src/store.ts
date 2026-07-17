import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import {
  selectOutgoingEdge,
  type ControlAction,
  type JsonObject,
  type JsonValue,
  type NodeVisitRecord,
  type NodeVisitStatus,
  type PendingInteractionRecord,
  type RunEventRecord,
  type RunRecord,
  type RunSessionRecord,
  type RunSnapshot,
  type RunStatus,
  type WorkflowDefinition,
} from "@emazna/loop-runtime";

type SqlRow = Record<string, unknown>;

const TERMINAL_STATUSES: RunStatus[] = ["completed", "failed", "cancelled"];

function now(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function defaultDatabasePath(): string {
  const local = process.env.LOCALAPPDATA ?? process.env.HOME ?? process.cwd();
  return join(local, "Emazna", "LoopCanvas", "loop-canvas.sqlite3");
}

function mapRun(row: SqlRow): RunRecord {
  return {
    id: String(row.id),
    workflowId: String(row.workflow_id),
    workflowVersionId: String(row.workflow_version_id),
    status: String(row.status) as RunStatus,
    state: parseJson<JsonObject>(row.state_json),
    activeSessionId: row.active_session_id ? String(row.active_session_id) : null,
    currentNodeVisitId: row.current_node_visit_id ? String(row.current_node_visit_id) : null,
    nextNodeId: row.next_node_id ? String(row.next_node_id) : null,
    visitCount: Number(row.visit_count),
    controlRevision: Number(row.control_revision),
    terminationReason: row.termination_reason ? String(row.termination_reason) : null,
    createdAt: String(row.created_at),
    startedAt: row.started_at ? String(row.started_at) : null,
    completedAt: row.completed_at ? String(row.completed_at) : null,
    updatedAt: String(row.updated_at),
  };
}

function mapVisit(row: SqlRow): NodeVisitRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    nodeId: String(row.node_id),
    visitOrdinal: Number(row.visit_ordinal),
    status: String(row.status) as NodeVisitStatus,
    inputSessionId: row.input_session_id ? String(row.input_session_id) : null,
    outputSessionId: row.output_session_id ? String(row.output_session_id) : null,
    codexTurnId: row.codex_turn_id ? String(row.codex_turn_id) : null,
    renderedPrompt: row.rendered_prompt ? String(row.rendered_prompt) : null,
    outputText: row.output_text ? String(row.output_text) : null,
    output: row.output_json ? parseJson<JsonValue>(row.output_json) : null,
    selectedEdgeId: row.selected_edge_id ? String(row.selected_edge_id) : null,
    error: row.error_json ? parseJson<JsonValue>(row.error_json) : null,
    startedAt: row.started_at ? String(row.started_at) : null,
    completedAt: row.completed_at ? String(row.completed_at) : null,
  };
}

function mapSession(row: SqlRow): RunSessionRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    codexThreadId: String(row.codex_thread_id),
    codexSessionId: String(row.codex_session_id),
    forkedFromThreadId: row.forked_from_thread_id ? String(row.forked_from_thread_id) : null,
    createdByVisitId: String(row.created_by_visit_id),
    cliVersion: String(row.cli_version),
    effectiveModel: String(row.effective_model),
    effectiveCwd: String(row.effective_cwd),
    effectiveApprovalPolicy: String(row.effective_approval_policy),
    effectiveSandbox: parseJson<JsonValue>(row.effective_sandbox_json),
    effectiveReasoningEffort: row.effective_reasoning_effort
      ? String(row.effective_reasoning_effort)
      : null,
    instructionSources: parseJson<string[]>(row.instruction_sources_json),
    status: String(row.status) as RunSessionRecord["status"],
    createdAt: String(row.created_at),
  };
}

function mapEvent(row: SqlRow): RunEventRecord {
  return {
    runId: String(row.run_id),
    seq: Number(row.seq),
    nodeVisitId: row.node_visit_id ? String(row.node_visit_id) : null,
    threadId: row.thread_id ? String(row.thread_id) : null,
    turnId: row.turn_id ? String(row.turn_id) : null,
    type: String(row.type),
    payload: parseJson<JsonValue>(row.payload_json),
    createdAt: String(row.created_at),
  };
}

function mapInteraction(row: SqlRow): PendingInteractionRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    nodeVisitId: String(row.node_visit_id),
    requestId: String(row.request_id),
    requestType: String(row.request_type),
    request: parseJson<JsonValue>(row.request_json),
    response: row.response_json ? parseJson<JsonValue>(row.response_json) : null,
    status: String(row.status) as PendingInteractionRecord["status"],
    createdAt: String(row.created_at),
    resolvedAt: row.resolved_at ? String(row.resolved_at) : null,
  };
}

export interface CreateSessionInput {
  runId: string;
  visitId: string;
  thread: {
    id: string;
    sessionId: string;
    forkedFromId?: string | null;
    cliVersion: string;
  };
  effective: {
    model: string;
    cwd: string;
    approvalPolicy: string;
    sandbox: JsonValue;
    reasoningEffort?: string | null;
    instructionSources?: string[];
  };
}

export interface CompleteVisitInput {
  runId: string;
  visitId: string;
  visitStatus: NodeVisitStatus;
  outputText?: string | null;
  output?: JsonValue | null;
  error?: JsonValue | null;
  selectedEdgeId?: string | null;
  state: JsonObject;
  nextNodeId: string | null;
  activeSessionId: string | null;
  runStatus: RunStatus;
  terminationReason?: string | null;
}

export class LoopStore {
  readonly db: Database.Database;
  readonly path: string;

  constructor(path = process.env.LOOP_CANVAS_DB_PATH || defaultDatabasePath()) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        definition_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workflow_versions (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL REFERENCES workflows(id),
        revision INTEGER NOT NULL,
        definition_json TEXT NOT NULL,
        definition_sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(workflow_id, revision)
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL REFERENCES workflows(id),
        workflow_version_id TEXT NOT NULL REFERENCES workflow_versions(id),
        cwd TEXT NOT NULL,
        status TEXT NOT NULL,
        state_json TEXT NOT NULL,
        active_session_id TEXT,
        current_node_visit_id TEXT,
        next_node_id TEXT,
        visit_count INTEGER NOT NULL DEFAULT 0,
        control_revision INTEGER NOT NULL DEFAULT 0,
        termination_reason TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_runs_cwd ON runs(cwd, status);

      CREATE TABLE IF NOT EXISTS run_sessions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        codex_thread_id TEXT NOT NULL,
        codex_session_id TEXT NOT NULL,
        forked_from_thread_id TEXT,
        created_by_visit_id TEXT NOT NULL,
        cli_version TEXT NOT NULL,
        effective_model TEXT NOT NULL,
        effective_cwd TEXT NOT NULL,
        effective_approval_policy TEXT NOT NULL,
        effective_sandbox_json TEXT NOT NULL,
        effective_reasoning_effort TEXT,
        instruction_sources_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_run ON run_sessions(run_id, created_at);

      CREATE TABLE IF NOT EXISTS node_visits (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        node_id TEXT NOT NULL,
        visit_ordinal INTEGER NOT NULL,
        status TEXT NOT NULL,
        input_session_id TEXT,
        output_session_id TEXT,
        codex_turn_id TEXT,
        rendered_prompt TEXT,
        output_text TEXT,
        output_json TEXT,
        selected_edge_id TEXT,
        error_json TEXT,
        started_at TEXT,
        completed_at TEXT,
        UNIQUE(run_id, visit_ordinal)
      );

      CREATE INDEX IF NOT EXISTS idx_visits_run ON node_visits(run_id, visit_ordinal);

      CREATE TABLE IF NOT EXISTS run_events (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        node_visit_id TEXT,
        thread_id TEXT,
        turn_id TEXT,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(run_id, seq)
      );

      CREATE TABLE IF NOT EXISTS control_commands (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        processed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_commands_pending ON control_commands(status, created_at);

      CREATE TABLE IF NOT EXISTS pending_interactions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        node_visit_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        request_type TEXT NOT NULL,
        request_json TEXT NOT NULL,
        response_json TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );

      CREATE TABLE IF NOT EXISTS runtime_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    // 同一cwdの排他は撤廃した（同じ作業フォルダでの同時実行は利用者の自己責任）。
    // 過去のDBに残っている排他インデックスは剥がす。
    this.db.exec("DROP INDEX IF EXISTS idx_runs_one_active_cwd");
  }

  ensureWorkflow(definition: WorkflowDefinition): WorkflowDefinition {
    const existing = this.getWorkflow(definition.id);
    if (existing) return existing;
    this.saveWorkflow(definition);
    return definition;
  }

  getWorkflow(id = "default"): WorkflowDefinition | null {
    const row = this.db.prepare("SELECT definition_json FROM workflows WHERE id = ?").get(id) as SqlRow | undefined;
    return row ? parseJson<WorkflowDefinition>(row.definition_json) : null;
  }

  saveWorkflow(definition: WorkflowDefinition): WorkflowDefinition {
    const saved = { ...definition, updatedAt: now() };
    this.db
      .prepare(`
        INSERT INTO workflows (id, name, definition_json, updated_at)
        VALUES (@id, @name, @definition, @updatedAt)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          definition_json = excluded.definition_json,
          updated_at = excluded.updated_at
      `)
      .run({ id: saved.id, name: saved.name, definition: json(saved), updatedAt: saved.updatedAt });
    return saved;
  }

  createRun(workflowId = "default"): RunRecord {
    const definition = this.getWorkflow(workflowId);
    if (!definition) throw new Error(`Workflow ${workflowId} was not found.`);
    const start = definition.nodes.find((node) => node.kind === "start");
    if (!start) throw new Error("Workflow has no Start node.");
    const first = selectOutgoingEdge(definition, start.id, definition.initialState);
    if (!first) throw new Error("Start node has no outgoing edge.");

    const runId = randomUUID();
    const versionId = randomUUID();
    const createdAt = now();
    const definitionJson = json(definition);
    const digest = createHash("sha256").update(definitionJson).digest("hex");

    const transaction = this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT COALESCE(MAX(revision), 0) AS revision FROM workflow_versions WHERE workflow_id = ?")
        .get(workflowId) as SqlRow;
      const revision = Number(row.revision) + 1;
      this.db
        .prepare(`INSERT INTO workflow_versions
          (id, workflow_id, revision, definition_json, definition_sha256, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`)
        .run(versionId, workflowId, revision, definitionJson, digest, createdAt);
      this.db
        .prepare(`INSERT INTO runs
          (id, workflow_id, workflow_version_id, cwd, status, state_json, next_node_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)`)
        .run(runId, workflowId, versionId, definition.cwd, json(definition.initialState), first.target, createdAt, createdAt);
      this.appendEventInTransaction(runId, "run.queued", { nextNodeId: first.target }, null, null, null);
    });
    transaction.immediate();
    return this.getRun(runId)!;
  }

  getRun(runId: string): RunRecord | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as SqlRow | undefined;
    return row ? mapRun(row) : null;
  }

  getLatestRun(): RunRecord | null {
    const row = this.db.prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT 1").get() as SqlRow | undefined;
    return row ? mapRun(row) : null;
  }

  listWorkflows(): Array<{ id: string; name: string; updatedAt: string }> {
    const rows = this.db
      .prepare("SELECT id, name, updated_at FROM workflows ORDER BY updated_at DESC")
      .all() as SqlRow[];
    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      updatedAt: String(row.updated_at),
    }));
  }

  getLatestRunForWorkflow(workflowId: string): RunRecord | null {
    const row = this.db
      .prepare("SELECT * FROM runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(workflowId) as SqlRow | undefined;
    return row ? mapRun(row) : null;
  }

  /** ワークフロー本体を削除する。過去のrun・不変バージョンは履歴として残す。 */
  deleteWorkflow(id: string): void {
    const active = this.db
      .prepare(`SELECT id FROM runs WHERE workflow_id = ?
        AND status NOT IN ('completed','failed','cancelled') LIMIT 1`)
      .get(id) as SqlRow | undefined;
    if (active) throw new Error("実行中（または未完了）のrunがあるため削除できません。先に停止してください。");
    this.db.prepare("DELETE FROM workflows WHERE id = ?").run(id);
  }

  getDefinitionForRun(runId: string): WorkflowDefinition {
    const row = this.db
      .prepare(`SELECT v.definition_json FROM workflow_versions v JOIN runs r ON r.workflow_version_id = v.id WHERE r.id = ?`)
      .get(runId) as SqlRow | undefined;
    if (!row) throw new Error(`Run ${runId} was not found.`);
    return parseJson<WorkflowDefinition>(row.definition_json);
  }

  getRunSnapshot(runId: string): RunSnapshot | null {
    return this.db.transaction(() => {
      const run = this.getRun(runId);
      if (!run) return null;
      const visits = (this.db.prepare("SELECT * FROM node_visits WHERE run_id = ? ORDER BY visit_ordinal").all(runId) as SqlRow[]).map(mapVisit);
      const sessions = (this.db.prepare("SELECT * FROM run_sessions WHERE run_id = ? ORDER BY created_at").all(runId) as SqlRow[]).map(mapSession);
      const events = (
        this.db
          .prepare("SELECT * FROM run_events WHERE run_id = ? ORDER BY seq DESC LIMIT 500")
          .all(runId) as SqlRow[]
      ).reverse().map(mapEvent);
      const pendingInteractions = (
        this.db.prepare("SELECT * FROM pending_interactions WHERE run_id = ? ORDER BY created_at").all(runId) as SqlRow[]
      ).map(mapInteraction);
      return { run, definition: this.getDefinitionForRun(runId), visits, sessions, events, pendingInteractions };
    })();
  }

  listEvents(runId: string, afterSeq = 0, limit = 500): RunEventRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?")
        .all(runId, afterSeq, limit) as SqlRow[]
    ).map(mapEvent);
  }

  appendEvent(
    runId: string,
    type: string,
    payload: JsonValue,
    nodeVisitId: string | null = null,
    threadId: string | null = null,
    turnId: string | null = null,
  ): RunEventRecord {
    return this.db.transaction(() =>
      this.appendEventInTransaction(runId, type, payload, nodeVisitId, threadId, turnId),
    ).immediate();
  }

  private appendEventInTransaction(
    runId: string,
    type: string,
    payload: JsonValue,
    nodeVisitId: string | null,
    threadId: string | null,
    turnId: string | null,
  ): RunEventRecord {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM run_events WHERE run_id = ?").get(runId) as SqlRow;
    const event: RunEventRecord = {
      runId,
      seq: Number(row.seq),
      nodeVisitId,
      threadId,
      turnId,
      type,
      payload,
      createdAt: now(),
    };
    this.db
      .prepare(`INSERT INTO run_events
        (run_id, seq, node_visit_id, thread_id, turn_id, type, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(runId, event.seq, nodeVisitId, threadId, turnId, type, json(payload), event.createdAt);
    return event;
  }

  claimQueuedRun(): RunRecord | null {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM runs WHERE status = 'queued' ORDER BY created_at LIMIT 1").get() as SqlRow | undefined;
      if (!row) return null;
      const updatedAt = now();
      const changed = this.db
        .prepare(`UPDATE runs SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ? AND status = 'queued'`)
        .run(updatedAt, updatedAt, String(row.id));
      if (changed.changes !== 1) return null;
      this.appendEventInTransaction(String(row.id), "run.started", {}, null, null, null);
      return this.getRun(String(row.id));
    }).immediate();
  }

  startNodeVisit(runId: string, nodeId: string, inputSessionId: string | null, renderedPrompt: string | null): NodeVisitRecord {
    return this.db.transaction(() => {
      const run = this.getRun(runId);
      if (!run) throw new Error(`Run ${runId} was not found.`);
      const visitId = randomUUID();
      const visitOrdinal = run.visitCount + 1;
      const startedAt = now();
      this.db
        .prepare(`INSERT INTO node_visits
          (id, run_id, node_id, visit_ordinal, status, input_session_id, rendered_prompt, started_at)
          VALUES (?, ?, ?, ?, 'running', ?, ?, ?)`)
        .run(visitId, runId, nodeId, visitOrdinal, inputSessionId, renderedPrompt, startedAt);
      this.db
        .prepare(`UPDATE runs SET current_node_visit_id = ?, next_node_id = NULL, visit_count = ?, updated_at = ? WHERE id = ?`)
        .run(visitId, visitOrdinal, startedAt, runId);
      this.appendEventInTransaction(runId, "node.visit.started", { nodeId, visitOrdinal }, visitId, null, null);
      return this.getVisit(visitId)!;
    }).immediate();
  }

  getVisit(visitId: string): NodeVisitRecord | null {
    const row = this.db.prepare("SELECT * FROM node_visits WHERE id = ?").get(visitId) as SqlRow | undefined;
    return row ? mapVisit(row) : null;
  }

  countVisitsForNode(runId: string, nodeId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM node_visits WHERE run_id = ? AND node_id = ?").get(runId, nodeId) as SqlRow;
    return Number(row.count);
  }

  attachTurn(visitId: string, turnId: string, sessionId: string): void {
    this.db
      .prepare("UPDATE node_visits SET codex_turn_id = ?, output_session_id = ? WHERE id = ?")
      .run(turnId, sessionId, visitId);
  }

  createSession(input: CreateSessionInput): RunSessionRecord {
    const id = randomUUID();
    const createdAt = now();
    this.db
      .prepare(`INSERT INTO run_sessions
        (id, run_id, codex_thread_id, codex_session_id, forked_from_thread_id, created_by_visit_id,
         cli_version, effective_model, effective_cwd, effective_approval_policy, effective_sandbox_json,
         effective_reasoning_effort, instruction_sources_json, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`)
      .run(
        id,
        input.runId,
        input.thread.id,
        input.thread.sessionId,
        input.thread.forkedFromId ?? null,
        input.visitId,
        input.thread.cliVersion,
        input.effective.model,
        input.effective.cwd,
        input.effective.approvalPolicy,
        json(input.effective.sandbox),
        input.effective.reasoningEffort ?? null,
        json(input.effective.instructionSources ?? []),
        createdAt,
      );
    return this.getSession(id)!;
  }

  getSession(id: string): RunSessionRecord | null {
    const row = this.db.prepare("SELECT * FROM run_sessions WHERE id = ?").get(id) as SqlRow | undefined;
    return row ? mapSession(row) : null;
  }

  setSessionStatus(id: string, status: RunSessionRecord["status"]): void {
    this.db.prepare("UPDATE run_sessions SET status = ? WHERE id = ?").run(status, id);
  }

  completeVisit(input: CompleteVisitInput): RunRecord {
    return this.db.transaction(() => {
      const completedAt = now();
      this.db
        .prepare(`UPDATE node_visits SET
          status = ?, output_text = ?, output_json = ?, selected_edge_id = ?, error_json = ?, completed_at = ?
          WHERE id = ?`)
        .run(
          input.visitStatus,
          input.outputText ?? null,
          input.output === undefined || input.output === null ? null : json(input.output),
          input.selectedEdgeId ?? null,
          input.error === undefined || input.error === null ? null : json(input.error),
          completedAt,
          input.visitId,
        );
      const isTerminal = TERMINAL_STATUSES.includes(input.runStatus);
      this.db
        .prepare(`UPDATE runs SET
          status = ?, state_json = ?, active_session_id = ?, current_node_visit_id = NULL,
          next_node_id = ?, termination_reason = ?, completed_at = ?, updated_at = ?
          WHERE id = ?`)
        .run(
          input.runStatus,
          json(input.state),
          input.activeSessionId,
          input.nextNodeId,
          input.terminationReason ?? null,
          isTerminal ? completedAt : null,
          completedAt,
          input.runId,
        );
      this.appendEventInTransaction(
        input.runId,
        "node.visit.completed",
        {
          status: input.visitStatus,
          selectedEdgeId: input.selectedEdgeId ?? null,
          nextNodeId: input.nextNodeId,
        },
        input.visitId,
        null,
        null,
      );
      if (isTerminal || input.runStatus === "paused" || input.runStatus === "recovery_required") {
        this.appendEventInTransaction(input.runId, `run.${input.runStatus}`, { reason: input.terminationReason ?? null }, null, null, null);
      }
      return this.getRun(input.runId)!;
    }).immediate();
  }

  setRunStatus(runId: string, status: RunStatus, reason: string | null = null): RunRecord {
    return this.db.transaction(() => {
      const changedAt = now();
      const isTerminal = TERMINAL_STATUSES.includes(status);
      this.db
        .prepare(`UPDATE runs SET status = ?, termination_reason = ?, control_revision = control_revision + 1,
          completed_at = CASE WHEN ? THEN ? ELSE completed_at END, updated_at = ? WHERE id = ?`)
        .run(status, reason, isTerminal ? 1 : 0, changedAt, changedAt, runId);
      this.appendEventInTransaction(runId, `run.${status}`, { reason }, null, null, null);
      return this.getRun(runId)!;
    }).immediate();
  }

  requeuePausedRun(runId: string): RunRecord {
    return this.db.transaction(() => {
      const changedAt = now();
      const result = this.db
        .prepare(`UPDATE runs SET status = 'queued', control_revision = control_revision + 1, updated_at = ? WHERE id = ? AND status = 'paused'`)
        .run(changedAt, runId);
      if (result.changes !== 1) throw new Error("Only a paused run can be resumed.");
      this.appendEventInTransaction(runId, "run.resume_requested", {}, null, null, null);
      return this.getRun(runId)!;
    }).immediate();
  }

  requeueRecoveryRun(runId: string, nextNodeId?: string): RunRecord {
    return this.db.transaction(() => {
      const changedAt = now();
      const result = this.db
        .prepare(`UPDATE runs SET status = 'queued', next_node_id = COALESCE(?, next_node_id),
          termination_reason = NULL, control_revision = control_revision + 1, updated_at = ?
          WHERE id = ? AND status = 'recovery_required'`)
        .run(nextNodeId ?? null, changedAt, runId);
      if (result.changes !== 1) throw new Error("Only a recovery-required run can be retried.");
      this.appendEventInTransaction(runId, "run.retry_requested", { nextNodeId: nextNodeId ?? null }, null, null, null);
      return this.getRun(runId)!;
    }).immediate();
  }

  enqueueControl(runId: string, action: ControlAction, payload: JsonValue = {}): string {
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO control_commands (id, run_id, type, payload_json, status, created_at)
        VALUES (?, ?, ?, ?, 'pending', ?)`)
      .run(id, runId, action, json(payload), now());
    return id;
  }

  recoverProcessingCommands(): number {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare("SELECT id, run_id, type FROM control_commands WHERE status = 'processing' ORDER BY created_at")
        .all() as SqlRow[];
      const retryable = new Set(["pause", "stop", "resume", "retry", "skip"]);
      const changedAt = now();
      for (const row of rows) {
        const type = String(row.type);
        const requeue = retryable.has(type);
        this.db
          .prepare("UPDATE control_commands SET status = ?, processed_at = ? WHERE id = ? AND status = 'processing'")
          .run(requeue ? "pending" : "failed", requeue ? null : changedAt, String(row.id));
        this.appendEventInTransaction(
          String(row.run_id),
          requeue ? "control.requeued_after_restart" : "control.outcome_unknown_after_restart",
          { action: type },
          null,
          null,
          null,
        );
      }
      return rows.length;
    }).immediate();
  }

  takePendingCommands(limit = 20): Array<{ id: string; runId: string; type: ControlAction; payload: JsonValue }> {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare("SELECT * FROM control_commands WHERE status = 'pending' ORDER BY created_at LIMIT ?")
        .all(limit) as SqlRow[];
      const claim = this.db.prepare("UPDATE control_commands SET status = 'processing' WHERE id = ? AND status = 'pending'");
      const claimed: Array<{ id: string; runId: string; type: ControlAction; payload: JsonValue }> = [];
      for (const row of rows) {
        if (claim.run(String(row.id)).changes === 1) {
          claimed.push({
            id: String(row.id),
            runId: String(row.run_id),
            type: String(row.type) as ControlAction,
            payload: parseJson<JsonValue>(row.payload_json),
          });
        }
      }
      return claimed;
    }).immediate();
  }

  finishCommand(id: string, succeeded = true): void {
    this.db
      .prepare("UPDATE control_commands SET status = ?, processed_at = ? WHERE id = ?")
      .run(succeeded ? "completed" : "failed", now(), id);
  }

  createPendingInteraction(
    runId: string,
    nodeVisitId: string,
    requestId: string,
    requestType: string,
    request: JsonValue,
  ): PendingInteractionRecord {
    return this.db.transaction(() => {
      const id = randomUUID();
      const createdAt = now();
      this.db
        .prepare(`INSERT INTO pending_interactions
          (id, run_id, node_visit_id, request_id, request_type, request_json, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`)
        .run(id, runId, nodeVisitId, requestId, requestType, json(request), createdAt);
      this.db.prepare("UPDATE runs SET status = 'waiting_input', updated_at = ? WHERE id = ?").run(createdAt, runId);
      this.appendEventInTransaction(runId, "run.waiting_input", { interactionId: id, requestType }, nodeVisitId, null, null);
      return this.getInteraction(id)!;
    }).immediate();
  }

  getInteraction(id: string): PendingInteractionRecord | null {
    const row = this.db.prepare("SELECT * FROM pending_interactions WHERE id = ?").get(id) as SqlRow | undefined;
    return row ? mapInteraction(row) : null;
  }

  answerInteraction(id: string, response: JsonValue): PendingInteractionRecord {
    const resolvedAt = now();
    this.db
      .prepare(`UPDATE pending_interactions SET response_json = ?, status = 'answered', resolved_at = ? WHERE id = ? AND status = 'pending'`)
      .run(json(response), resolvedAt, id);
    return this.getInteraction(id)!;
  }

  markConnectionInteractionsLost(runId: string): void {
    this.db
      .prepare(`UPDATE pending_interactions SET status = 'connection_lost', resolved_at = ? WHERE run_id = ? AND status = 'pending'`)
      .run(now(), runId);
  }

  markRunRecoveryRequired(runId: string, reason: string): RunRecord {
    return this.db.transaction(() => {
      const run = this.getRun(runId);
      if (!run) throw new Error(`Run ${runId} was not found.`);
      const changedAt = now();
      const activeVisit = run.currentNodeVisitId ? this.getVisit(run.currentNodeVisitId) : null;
      if (activeVisit?.status === "running") {
        this.db
          .prepare("UPDATE node_visits SET status = 'outcome_unknown', completed_at = ? WHERE id = ? AND status = 'running'")
          .run(changedAt, activeVisit.id);
      }
      this.db
        .prepare(`UPDATE pending_interactions SET status = 'connection_lost', resolved_at = ?
          WHERE run_id = ? AND status = 'pending'`)
        .run(changedAt, runId);
      this.db
        .prepare(`UPDATE runs SET status = 'recovery_required', current_node_visit_id = NULL,
          next_node_id = COALESCE(next_node_id, ?), termination_reason = ?,
          control_revision = control_revision + 1, updated_at = ? WHERE id = ?`)
        .run(activeVisit?.nodeId ?? null, reason, changedAt, runId);
      this.appendEventInTransaction(runId, "run.recovery_required", { reason }, null, null, null);
      return this.getRun(runId)!;
    }).immediate();
  }

  recoverAbandonedRuns(): number {
    const rows = this.db
      .prepare(`SELECT id FROM runs WHERE status IN ('running','pause_requested','waiting_input','interrupting')`)
      .all() as SqlRow[];
    for (const row of rows) {
      this.markRunRecoveryRequired(String(row.id), "Runner restarted during an in-flight turn.");
    }
    return rows.length;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(`INSERT INTO runtime_meta (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(key, value, now());
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM runtime_meta WHERE key = ?").get(key) as SqlRow | undefined;
    return row ? String(row.value) : null;
  }

  getOrCreateControlToken(): string {
    return this.db.transaction(() => {
      const existing = this.getMeta("control_token");
      if (existing) return existing;
      const token = randomUUID() + randomUUID();
      const createdAt = now();
      this.db
        .prepare("INSERT INTO runtime_meta (key, value, updated_at) VALUES ('control_token', ?, ?)")
        .run(token, createdAt);
      return token;
    }).immediate();
  }
}
