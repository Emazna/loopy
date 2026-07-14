"use client";

import type {
  AgentNode,
  DecisionNode,
  JsonObject,
  JsonValue,
  NodeKind,
  PendingInteractionRecord,
  SessionPolicy,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
} from "@emazna/loop-runtime";
import {
  AlertTriangle,
  Bot,
  CornerDownRight,
  GitBranch,
  LockKeyhole,
  Play,
  Send,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { isRecord, textValue } from "./ui-types";

const NODE_KIND_LABEL: Record<NodeKind, string> = {
  start: "開始",
  agent: "実行",
  decision: "分岐",
  end: "終了",
};

interface WorkflowSettingsPanelProps {
  workflow: WorkflowDefinition;
  disabled: boolean;
  onChange: (patch: Partial<WorkflowDefinition>) => void;
  onAddNode: (kind: "agent" | "decision") => void;
}

export function WorkflowSettingsPanel({ disabled, onAddNode }: WorkflowSettingsPanelProps) {
  return (
    <aside aria-label="ブロックの追加" className="settings-panel panel-surface">
      {disabled ? (
        <p className="editing-lock-note">
          <LockKeyhole aria-hidden="true" size={14} />
          実行中は編集できません。
        </p>
      ) : null}

      <div className="node-palette">
        <button disabled={disabled} onClick={() => onAddNode("agent")} type="button">
          <Play aria-hidden="true" size={15} />
          <span><strong>実行</strong></span>
        </button>
        <button disabled={disabled} onClick={() => onAddNode("decision")} type="button">
          <GitBranch aria-hidden="true" size={15} />
          <span><strong>分岐</strong></span>
        </button>
      </div>

      {/* 詳細設定（ワークフロー名・モデル・作業フォルダ・思考の深さ）は一旦非表示。
      <details className="settings-details">
        <summary>詳細設定</summary>
        <div className="form-stack">
          <label className="field-label">
            ワークフロー名
            <input disabled={disabled} onChange={(event) => onChange({ name: event.target.value })} value={workflow.name} />
          </label>
          <label className="field-label">
            モデル
            <input autoComplete="off" disabled={disabled} onChange={(event) => onChange({ model: event.target.value })} spellCheck={false} value={workflow.model} />
          </label>
          <label className="field-label">
            作業フォルダ
            <input autoComplete="off" className="mono-input" disabled={disabled} onChange={(event) => onChange({ cwd: event.target.value })} spellCheck={false} value={workflow.cwd} />
          </label>
          <label className="field-label">
            思考の深さ
            <select disabled={disabled} onChange={(event) => onChange({ reasoningEffort: event.target.value as ReasoningEffort })} value={workflow.reasoningEffort}>
              <option value="low">浅い</option>
              <option value="medium">ふつう</option>
              <option value="high">深い</option>
              <option value="xhigh">最も深い</option>
            </select>
          </label>
        </div>
      </details>
      */}
    </aside>
  );
}

interface NodeInspectorProps {
  node: WorkflowNode | null;
  disabled: boolean;
  onChange: (nodeId: string, patch: Partial<WorkflowNode>) => void;
  onDelete: (nodeId: string) => void;
}

export function NodeInspector({ node, disabled, onChange, onDelete }: NodeInspectorProps) {
  const isFixed = node?.kind === "start" || node?.kind === "end";

  return (
    <aside aria-label="選択中のブロック" className="inspector-panel panel-surface">
      <div className="panel-heading">
        <span className="panel-heading__icon"><Bot aria-hidden="true" size={16} /></span>
        <div>
          <p className="panel-kicker">選択中</p>
          <h2>{node ? node.title : "ブロックを選択"}</h2>
        </div>
      </div>

      {!node ? (
        <div className="inspector-empty">
          <CornerDownRight aria-hidden="true" size={20} />
          <p>Canvas上のブロックを選ぶと、ここで編集できます。</p>
        </div>
      ) : (
        <div className="form-stack inspector-form">
          <div className="node-type-line">
            <span>{NODE_KIND_LABEL[node.kind]}</span>
          </div>
          <label className="field-label">
            タイトル
            <input
              disabled={disabled || isFixed}
              onChange={(event) => onChange(node.id, { title: event.target.value })}
              value={node.title}
            />
          </label>

          {node.kind === "agent" ? (
            <AgentFields disabled={disabled} node={node} onChange={onChange} />
          ) : null}

          {node.kind === "decision" ? (
            <DecisionFields disabled={disabled} node={node} onChange={onChange} />
          ) : null}

          {isFixed ? (
            <p className="inspector-hint">このブロックは常に必要なので、削除できません。</p>
          ) : (
            <div className="selection-danger">
              <button
                className="button button--danger-outline button--full"
                disabled={disabled}
                onClick={() => onDelete(node.id)}
                type="button"
              >
                <Trash2 aria-hidden="true" size={14} />
                削除
              </button>
              <small>つながっている線も一緒に消えます。</small>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}

function AgentFields({
  node,
  disabled,
  onChange,
}: {
  node: AgentNode;
  disabled: boolean;
  onChange: (nodeId: string, patch: Partial<WorkflowNode>) => void;
}) {
  const direction = node.direction === "left" ? "left" : "right";
  return (
    <>
      <label className="field-label">
        プロンプト
        <textarea
          disabled={disabled}
          onChange={(event) => onChange(node.id, { prompt: event.target.value } as Partial<AgentNode>)}
          placeholder="このブロックでCodexにさせたいことを書きます"
          rows={12}
          value={node.prompt}
        />
      </label>
      <div className="direction-field">
        <span className="field-label direction-field__label">向き</span>
        <div className="direction-toggle" role="group" aria-label="ブロックの向き">
          <button
            aria-pressed={direction === "right"}
            className={direction === "right" ? "is-selected" : ""}
            disabled={disabled}
            onClick={() => onChange(node.id, { direction: "right" } as Partial<AgentNode>)}
            type="button"
          >
            → 右向き
          </button>
          <button
            aria-pressed={direction === "left"}
            className={direction === "left" ? "is-selected" : ""}
            disabled={disabled}
            onClick={() => onChange(node.id, { direction: "left" } as Partial<AgentNode>)}
            type="button"
          >
            ← 左向き
          </button>
        </div>
        <small className="direction-field__hint">戻る流れ（ループ）を作るときは左向きにすると線が描きやすくなります。</small>
      </div>
      <label className="check-field">
        <input
          checked={node.sessionPolicy === "fresh"}
          disabled={disabled}
          onChange={(event) =>
            onChange(node.id, {
              sessionPolicy: (event.target.checked ? "fresh" : "continue") as SessionPolicy,
            } as Partial<AgentNode>)
          }
          type="checkbox"
        />
        <span>
          <strong>新しいセッションで始める</strong>
          <small>前のブロックの内容を引き継がず、まっさらな状態で実行します。ふだんは引き継いだまま進みます。</small>
        </span>
      </label>
    </>
  );
}

function DecisionFields({
  node,
  disabled,
  onChange,
}: {
  node: DecisionNode;
  disabled: boolean;
  onChange: (nodeId: string, patch: Partial<WorkflowNode>) => void;
}) {
  return (
    <>
      <label className="field-label">
        質問
        <textarea
          disabled={disabled}
          onChange={(event) => onChange(node.id, { question: event.target.value } as Partial<DecisionNode>)}
          placeholder="例：修正点がもう存在しないかどうか"
          rows={4}
          value={node.question}
        />
      </label>
      <p className="inspector-hint">
        この質問にCodexが答えます。答えの選択肢は、この分岐から出ている線の「基準」です。線を選ぶと基準を変更できます。
      </p>
    </>
  );
}

interface EdgeInspectorProps {
  edge: WorkflowEdge;
  sourceTitle: string;
  targetTitle: string;
  sourceKind: NodeKind;
  disabled: boolean;
  onChange: (edgeId: string, patch: Partial<WorkflowEdge>) => void;
  onDelete: (edgeId: string) => void;
}

export function EdgeInspector({
  edge,
  sourceTitle,
  targetTitle,
  sourceKind,
  disabled,
  onChange,
  onDelete,
}: EdgeInspectorProps) {
  const isFromDecision = sourceKind === "decision";
  return (
    <aside aria-label="選択中の線" className="inspector-panel panel-surface">
      <div className="panel-heading">
        <span className="panel-heading__icon"><GitBranch aria-hidden="true" size={16} /></span>
        <div>
          <p className="panel-kicker">選択中の線</p>
          <h2>{sourceTitle} → {targetTitle}</h2>
        </div>
      </div>
      <div className="form-stack inspector-form">
        {isFromDecision ? (
          <>
            <label className="field-label">
              基準（回答の選択肢）
              <input
                disabled={disabled}
                onChange={(event) => onChange(edge.id, { label: event.target.value })}
                placeholder="例：はい"
                value={edge.label}
              />
            </label>
            <p className="inspector-hint">
              分岐の質問にCodexが答えるとき、この基準が選ばれるとこの線へ進みます。基準は線の上にラベルとして表示されます。
            </p>
          </>
        ) : (
          <p className="inspector-hint">この線は、前のブロックが終わると次へ進みます。設定は不要です。</p>
        )}
        <div className="selection-danger">
          <button
            className="button button--danger-outline button--full"
            disabled={disabled}
            onClick={() => onDelete(edge.id)}
            type="button"
          >
            <Trash2 aria-hidden="true" size={14} /> 削除
          </button>
          <small>選択してDeleteキーでも削除できます。</small>
        </div>
      </div>
    </aside>
  );
}

interface QuestionOption {
  label: string;
  description: string;
}

interface InputQuestion {
  id: string;
  header: string;
  question: string;
  options: QuestionOption[];
}

function extractQuestions(request: JsonValue): InputQuestion[] {
  if (!isRecord(request) || !Array.isArray(request.questions)) return [];
  return request.questions.flatMap((candidate, index) => {
    if (!isRecord(candidate)) return [];
    const id = textValue(candidate.id, `question_${index + 1}`);
    const question = textValue(candidate.question, textValue(candidate.prompt, "回答を入力してください"));
    const options = Array.isArray(candidate.options)
      ? candidate.options.flatMap((option) => {
          if (typeof option === "string") return [{ label: option, description: "" }];
          if (!isRecord(option)) return [];
          return [{
            label: textValue(option.label, textValue(option.value, "選択肢")),
            description: textValue(option.description),
          }];
        })
      : [];
    return [{ id, question, header: textValue(candidate.header, "エージェントからの確認"), options }];
  });
}

export function PendingInputPanel({
  interaction,
  busy,
  onAnswer,
}: {
  interaction: PendingInteractionRecord;
  busy: boolean;
  onAnswer: (interactionId: string, answers: JsonValue) => Promise<void>;
}) {
  const questions = useMemo(() => extractQuestions(interaction.request), [interaction.request]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const fallbackId = "answer";

  useEffect(() => {
    setAnswers({});
  }, [interaction.id]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ids = questions.length > 0 ? questions.map((question) => question.id) : [fallbackId];
    const formatted: JsonObject = {};
    for (const id of ids) formatted[id] = { answers: [answers[id]?.trim() ?? ""] };
    await onAnswer(interaction.id, formatted);
  }

  return (
    <form className="human-input-card" onSubmit={submit}>
      <div className="human-input-card__heading">
        <span><AlertTriangle aria-hidden="true" size={16} /></span>
        <div>
          <p className="panel-kicker">あなたの回答待ち</p>
          <h3>エージェントから確認があります</h3>
        </div>
      </div>
      {questions.length > 0 ? questions.map((question, index) => (
        <fieldset className="question-fieldset" key={question.id}>
          <legend>{question.header}</legend>
          <p>{question.question}</p>
          {question.options.length > 0 ? (
            <div className="answer-options">
              {question.options.map((option) => (
                <label key={option.label}>
                  <input
                    checked={answers[question.id] === option.label}
                    name={`answer-${question.id}`}
                    onChange={() => setAnswers((current) => ({ ...current, [question.id]: option.label }))}
                    type="radio"
                  />
                  <span><strong>{option.label}</strong>{option.description ? <small>{option.description}</small> : null}</span>
                </label>
              ))}
            </div>
          ) : null}
          <label className="field-label">
            {question.options.length > 0 ? "または自由入力" : "回答"}
            <textarea
              autoFocus={index === 0}
              onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
              required
              rows={3}
              value={answers[question.id] ?? ""}
            />
          </label>
        </fieldset>
      )) : (
        <label className="field-label">
          回答
          <textarea
            autoFocus
            onChange={(event) => setAnswers({ [fallbackId]: event.target.value })}
            required
            rows={4}
            value={answers[fallbackId] ?? ""}
          />
        </label>
      )}
      <button className="button button--primary button--full" disabled={busy} type="submit">
        <Send aria-hidden="true" size={15} />
        {busy ? "送信中…" : "回答して続ける"}
      </button>
    </form>
  );
}
