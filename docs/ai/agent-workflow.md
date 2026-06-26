# Agent Workflow

## 基本方針

コード修正・機能追加・バグ修正など、あらゆる開発タスクは必ず `feature-dev` エージェントを通して行う。

すべてのエージェント起動は main が行う。サブエージェント間で直接指示はできない。

## エージェント一覧

| エージェント | 役割 |
|---|---|
| `feature-dev` | 開発全部（コード・仕様書・バージョン・受け入れテスト更新） |
| `debugger` | バグ調査のみ（読み取り専用） |
| `acceptance-test` | 受け入れテスト実行・ステータス `■■■` 反映 |
| `publisher` | build / commit / push |

## 開発フロー

1. main が `feature-dev` を起動する。
2. `feature-dev` がコード修正、仕様書更新（ステータス `■■□`）、バージョンバンプ、受け入れテスト更新を一括で行う。
3. バグ調査が必要な場合は main が `debugger` を起動する。
4. 受け入れテストはユーザーから明示的に指示があった場合のみ、main が `acceptance-test` を起動して実行する。指示がない場合はスキップする。
5. FAIL がある場合は main が `feature-dev` を再起動して修正させる。
6. PASS / SKIP のみ、または受け入れテストがスキップされた場合、main が `publisher` を起動する。

## feature-dev のルール

- `feature-dev` は `npm test` を実行しない。テスト実行は `acceptance-test` の責務。
- テストコードの更新・追加は行ってよい。
- 検証は `npm run build`。型が不安なら `npx tsc --noEmit -p tsconfig.json` を使う。
- `_handleExport` の filters 由来の strict エラーは既知・無関係で無視可。
- 要件を変えたら `docs/requirements-usdm.md` を更新し、`package.json` のバージョンを揃える。
- アーキテクチャを変えたら `docs/architecture.md` と関連 ADR を確認・更新する。
- バージョンポリシーは、要件変更ありならマイナーアップ、コード修正のみならパッチアップ。

## エージェント定義の管理

エージェント定義（Claude Code = `.claude/agents/*.md`、Codex = `.codex/agents/*.toml`）は `C:\Claude Code\_agent-templates`（正本）から配布された同期コピー。

直接編集せず、正本を編集して `_agent-templates\sync-agents.ps1` を実行する。直接編集は次回同期で上書きされる。
