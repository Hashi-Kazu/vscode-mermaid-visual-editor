# Agent Workflow

## 基本方針

開発タスクは自明かどうかで処理を分ける。自明な修正（typo・1〜2 行・設定値変更）は main が直接実行し、非自明なタスクは `planner` を経由して調査・仕様策定を行ってから実装する。

すべてのエージェント起動は main が行う。サブエージェント間で直接指示はできない。

## エージェント一覧

| エージェント | 役割 |
|---|---|
| `planner` | 調査・仕様策定・Codex 引き渡し票生成（読み取り専用） |
| `feature-dev` | 実装担当（通常は Codex が実行。「Claude で実装して」時または codex exec 失敗後に Claude のサブエージェントとして起動） |
| `acceptance-test` | 受け入れテスト実行・ステータス `■■■` 反映 |

## 開発フロー

1. main がタスクを評価する。
2. **自明な修正**（typo・1〜2 行・設定値変更）は main が直接実行（ここで終了）。
3. 非自明な場合、main が `planner` を起動する。
4. `planner` が調査・仕様策定を行い、Codex 引き渡し票を出力する。
5. main が実装ランタイムを選択する：
   - デフォルト → `codex exec --sandbox workspace-write "[引き渡し票]"` で Codex が実装・ビルド検証・テストコード作成
   - 「Claude で実装して」→ `feature-dev` サブエージェントで Claude が実装
   - `codex exec` 失敗 → エラーを報告して停止。「Claude でやって」の指示後に `feature-dev` を起動
6. 受け入れテストの明示指示がある場合、main が `acceptance-test` を起動する。
7. FAIL がある場合は main が実装を再起動して修正させる。
8. main が AGENTS.md の「publish 手順」に従って直接 build / commit / push を実行する。

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
