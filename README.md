# Loopy

*A local-only visual loop orchestrator / debugger for the OpenAI Codex CLI App Server: draw agent blocks and LLM-judged branches on a canvas, run them as real Codex turns, and pause / interrupt / inspect every step. UI is currently Japanese.*

Codex App Serverのthread、turn、分岐、反復、停止、実行証跡を視覚的に扱う、ローカル専用のVisual Loop Control Plane / Debuggerです。Canvasに「実行」ブロック（プロンプト）と「分岐」ブロック（Codexが答える質問と、線ごとの基準）を描き、そのままCodexで実行できます。

> [!WARNING]
> **実験的なプロトタイプです。** ワークフローは固定working directoryへ **`danger-full-access`（承認なしのファイル変更・コマンド実行）** で実行されます。信頼できるworkflowとworkspaceだけで、自己責任で使用してください。サポートは保証しません。

Emazna株式会社が開発しています。本プロジェクトはOpenAIの公式プロダクトではなく、OpenAIとは無関係です（Codex CLIのApp Serverプロトコルを利用するサードパーティツールです）。

技術識別子（環境変数 `LOOP_CANVAS_*`、パッケージ名）は旧称 Loop Canvas 由来の `loop-canvas` を互換性のため維持します。

## 実装済み

- Next.js App Router + `@xyflow/react`のworkflow canvas（node追加・削除、self-loopを含むedge接続、分岐の質問・基準編集）
- 開始 / 実行 / 分岐 / 終了、Codex判定の分岐（質問＋基準ラベル）、循環edge
- workflow単位の固定model / cwd / approval `never` / `danger-full-access`
- Agent node単位のFresh / Continue session
- Explicit Stateへのnode output保存とprompt interpolation
- SQLite WALによるworkflow version、run cursor、node visit、session、event、control commandの永続化
- Next.jsとは別processのresident Runner
- Codex App Server 0.135.0のstdio JSONL接続
- `initialize` → `initialized`、`thread/start` / `resume`、`turn/start`、`turn/interrupt`
- streamed reasoning summary、agent message、command、diff、routeの正規化
- SSEのevent id、`Last-Event-ID` replay、heartbeat
- soft pause、resume、interrupt、stop、recovery-required
- `requestUserInput`のdurable UI待機。ただし回答は同じlive App Server connectionにだけ返す
- immutable WorkflowVersionとrequested / effective session設定の保存
- 同じcwdのactive run重複防止、single Runner lock、automatic retry 0
- node visit数、node別visit数、turn時間、run総時間の有限budget
- Codex CLI version guardと、key順を正規化した再現可能なprotocol schema hash
- raw chain-of-thoughtの破棄
- **エンジン切り替え（Codex / Claude）**: ヘッダー左上でエンジンとモデルを選択
- **複数ワークフロー**: 名前を付けて保存・複製・削除でき、ヘッダー左上のセレクタで切り替える。URLは `/?workflow=<id>` なので、**ブラウザの別タブで別ワークフローを開いて同時に実行できる**（既定は3並行、`LOOP_CANVAS_MAX_PARALLEL_RUNS` で変更）。同じ作業フォルダを指すワークフローも同時に実行できるが、同じファイルを同時に触ったときの衝突（上書き・gitロック等）は防がない（利用者の自己責任）

## エンジン（Codex / Claude）

ワークフローごとに実行エンジンを選べます。ヘッダー左上のセレクタで切り替え、右のセレクタでモデルとインテリジェンス（思考の深さ）を選びます。インテリジェンスの選択肢はモデルごとに変わり（下表）、対応しないモデルへ切り替えたときは選べる中で最も深い段階へ自動で収めます。Claudeエンジンではインテリジェンスは使われないため、セレクタ自体を表示しません。

| | Codex | Claude |
|---|---|---|
| 実体 | Codex CLI App Server（stdio JSONL常駐） | Claude Code CLI（`claude --print`を1ターン=1プロセスで起動） |
| 課金 | Codex側の契約 | **Claude Code のサブスクリプション枠を消費**（ログイン済みアカウント。`CLAUDE_CODE_OAUTH_TOKEN`があれば引き継ぐ） |
| モデル | gpt-5.4 / gpt-5.4-mini / gpt-5.5 / gpt-5.6-sol / gpt-5.6-terra / gpt-5.6-luna / gpt-5.3-codex-spark | claude-sonnet-5 / claude-fable-5 / claude-opus-4-8 / claude-haiku-4-5-20251001 |
| セッション継続 | `thread/resume` | 初回 `--session-id <uuid>`、以降 `--resume <uuid>` |
| フルアクセス | approval `never` + `danger-full-access` | `--dangerously-skip-permissions`（同等の効果として扱う） |
| 分岐（構造化出力） | `outputSchema` をサーバーへ渡す | schemaをプロンプトに付加し、runner側でJSON検証 |
| 中断・停止 | `turn/interrupt` | プロセスツリーをkill |
| `requestUserInput`（回答待ち） | 対応 | **非対応**（ヘッドレスのため対話確認は発生しない） |
| インテリジェンス（reasoningEffort） | 反映。低〜XHigh、gpt-5.6-lunaはMaxまで、gpt-5.6-sol/terraはUltraまで | 無視される（セレクタ非表示） |

Claudeエンジンの要件: Claude Code CLI がインストール済みで（例: `npm install -g @anthropic-ai/claude-code`）、ログイン済みであること。実体のパスは `LOOP_CANVAS_CLAUDE_BIN` で上書きできます。動作確認は `npm run smoke:claude`（haikuで2ターン: セッション継続と構造化出力を検証）。

## UI方針（2026-07-15）

- 表示名は **Loopy**。UI文言は日本語を正とする（バリデーション、実行状態、通知、確認ダイアログ、ランナーの状態・エラー文言を含む）。
- **コンテキストはセッション継続で渡す。** Step Functions的な明示state受け渡し（`{{state.task}}` 等のテンプレ、グローバルtask入力）はUIから排除する。エージェントを追加したときの既定は「前のブロックの内容を引き継ぐ（continue）」で、プロンプトは空から書き始める。ブロック設定で「新しいセッションで始める（fresh）」に切り替えられる。
- **分岐の判定はCodexが行う。** 分岐ブロックには「質問」（例: 修正点がもう存在しないかどうか）だけを書く。分岐から出る各線には「基準」（回答の選択肢。既定は はい/いいえ、3本目以降は 選択肢N）を付け、基準は線の上にラベルとして表示する。実行時は、質問と基準一覧をセッション継続の1ターンとしてCodexへ渡し、構造化出力（enum）で選ばれた基準の線へ進む。stateパス比較による条件式は廃止。
- ノードの見た目: 開始・終了は縦長のオレンジ終端ブロック。**実行（エージェント）は再生ボタンのような矢印形**で、流れの向きが分かる。**分岐は丸**。
- 実行ブロックは**左右の向きを切り替えられる**（左向き=左が尖る）。戻る流れ（ループ）を作るときに線が描きやすい。ハンドル（入口/出口）も向きに合わせて反転する。
- 通常の線（分岐以外から出る線）はラベルを表示しない。分岐から出る線は点線＋基準ラベル。
- 左の設定パネルは置かない。Canvasを左いっぱいに広げ、**Canvas左上に「ブロック」という小さな常設パレット**（実行・分岐の2ボタンのみ）を浮かせる。実行中はパレットも無効化する。**終了ブロックは常に右側に1つ置き、削除できない**（開始も同様）。
- ワークフロー全体のタスク入力欄は置かない。ステップ数・時間の上限はUIから設定させない。詳細設定（名前・モデル・作業フォルダ・思考の深さ）は一旦コメントアウトで非表示。
- フルアクセスの常設表示は置かない。実行の確認ダイアログにだけ、モデル・作業フォルダと短い注意を出す。実行エンジン/Codexの接続バッジもヘッダーから外す。
- Canvas左上の「下書き」ステータスは非表示（実行中・実行後の状態表示のみ残す）。
- 記録（下部）はタブを「すべて・エージェント・コマンド」に絞る。各記録には、どのブロックで起きたかをラベルで付ける。
- ボックス・線の削除はトーストの「元に戻す」で1段階取り消せる。未保存の変更があるままタブを閉じるときは警告する。

## Architecture

```text
Browser
  ├─ REST controls ───────► Next.js (127.0.0.1:4320)
  └─ SSE trace ◄──────────┘          │
                                      ▼
                                  SQLite WAL
                                      ▲
                                      │ durable queue / events
Resident Runner ── stdio JSONL ── Codex App Server
                                      │
                                      ▼
                           Fixed cwd / danger-full-access
```

Next.jsのrequest内ではturnを実行しません。browserやNext.jsが再起動しても、別processのRunnerがrunを保持します。Runner/App Serverがin-flight turn中に落ちた場合は、同じfull-access turnを自動再実行せず`recovery_required`にします。

## Requirements

- Windows 11で検証済み
- Node.js `20.9+`（local検証: `24.14.1`）
- npm（local検証: `11.11.0`）
- Codex CLI `0.144.4`（Max/Ultraインテリジェンスの解釈に`0.144+`が必要）
- `codex login status`が成功すること
- ローカル検証済みmodel: `gpt-5.4`、`gpt-5.6-sol`（Ultra）

## Start

```powershell
git clone https://github.com/Emazna/loopy.git
cd loopy
npm install
npm run codex:generate
npm run dev
```

ブラウザで [http://127.0.0.1:4320](http://127.0.0.1:4320) を開きます。

必要な場合は、起動前に環境変数を上書きします（`.env.example` 参照）。**`LOOP_CANVAS_WORKDIR` が未設定の場合、Codexの作業フォルダはLoopyを起動したフォルダになります。**

```powershell
$env:LOOP_CANVAS_MODEL='gpt-5.4'
$env:LOOP_CANVAS_WORKDIR='C:\path\to\your\workspace'
$env:LOOP_CANVAS_DB_PATH="$env:LOCALAPPDATA\Emazna\LoopCanvas\loop-canvas.sqlite3"
$env:LOOP_CANVAS_CODEX_BIN='codex'
npm run dev
```

既定DBは`%LOCALAPPDATA%\Emazna\LoopCanvas\loop-canvas.sqlite3`です。`CODEX_HOME`を指定しなければ、現在ログイン済みのCodex homeを使います。専用`CODEX_HOME`へ切り替える場合は、そのhomeでも認証が必要です。

## Verification

```powershell
npm run typecheck
npm test
npm run build
npm run smoke:app-server
npm run smoke:runtime
npm run smoke:controls
```

- `smoke:app-server`: 一時workspaceでfull-access threadを開始し、実際のCodexがsentinelを読み、JSON schemaどおり返すことを確認
- `smoke:runtime`: Fresh → Continue → Fresh → Decision → Endを実行し、2つのCodex threadとexplicit stateを確認
- `smoke:controls`: active turnへのsoft pause、node境界resume、`turn/interrupt`、`recovery_required`を確認

2026-07-14のローカル実測では、3本すべて成功しています。

## Safety semantics

- **Pause after step**: 現在のturnは完了させ、次の`turn/start`直前で停止します。
- **Interrupt now**: 現在のturnをcancelします。同じ場所からの再開ではありません。
- **Stop**: runの進行を止めますが、既に発生したfile changeや外部side effectをrollbackしません。
- Interrupt / Stop後5秒以内にterminal通知が来なければApp Serverをcloseし、runを`recovery_required`へ倒します。
- `maxRunMinutes`は未設定なら実行時間の上限なし（既定）。設定した場合はpause中も含むwall-clock上限です。
- `turnTimeoutMinutes`（既定30分）は**無活動タイムアウト**です。エージェントからイベント（本文・推論サマリー・コマンド出力など）が流れ続けている限り1ターンが何時間かかっても打ち切りません。イベントが全く途絶えたままこの時間が経過したときだけ、ハングとみなして中断し`recovery_required`へ倒します。出力を一切吐かない長時間コマンド実行中は「無活動」に見える点に注意してください。
- `turn/interrupt`はbackground terminalを終了しません。prototypeでは残存processを自動的に「停止済み」と扱いません。
- Claudeエンジンのturnは子プロセスの`exit`で確定します（`close`待ちにしない）。エージェントがバックグラウンドで起動したdevサーバー等の孫プロセスがstdioパイプを継承したまま生き残ると`close`は発火しないため、`close`だけに頼ると完了済みのturnが無限に待たされます。
- transport loss、timeout、Runner restartでturn outcomeが不明な場合、automatic retryは行いません。
- reasoning summaryはActivityとして保存しますが、raw reasoning eventは保存・配信しません。

## Known prototype limits

- local single-user / single Runnerのみ（1つのRunnerプロセスが複数runを並行実行する）
- 同一cwdのparallel runも許可する。同じファイルへの同時書き込み・gitの排他・ビルド成果物の競合などは検知も防止もしない（自己責任）
- Fork session、named session lane、unbounded Continuous mode、parallel fan-outは未実装
- node追加・削除・edge接続はMVP UIの範囲。高度なschema editorやversion diffは未実装
- App Serverはplugins/appsを無効化して起動しますが、ユーザーのMCP設定に由来するstartup notificationが現れる場合があります
- `requestUserInput`待機中にRunner/App Serverが再起動した場合、元requestへ回答できないため`recovery_required`になります
- archiveは削除ではありません。thread retention UIは未実装です

## Package layout

```text
apps/web                         Next.js UI / REST / SSE
apps/runner                      durable graph runner
packages/codex-app-server-adapter  stdio JSONL protocol adapter
packages/loop-runtime            graph types / validation / state mapping
packages/loop-storage            SQLite store
scripts                          schema generation and real-binary smoke tests
```

## License

[Apache License 2.0](./LICENSE) © Emazna Inc.

Codex is a product of OpenAI. This project is not affiliated with or endorsed by OpenAI.
