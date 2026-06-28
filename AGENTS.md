# vscode-mermaid-visual-editor

VS Code extension for Mermaid diagram preview and editing. TypeScript + esbuild + VS Code API.

## 必須ルール

- **自明な修正**（typo・1〜2 行・設定値変更）は main が直接実行し、publish 手順に従って commit & push する。サブエージェントは起動しない。
- **非自明なタスク**は以下の順で実行する（自分でコードを読んで調査しない。即 `planner` を起動する）：
  1. `planner` を起動 → 調査・仕様策定・引き渡し票を生成
  2. 実装ランタイムを選択：
     - デフォルト → `codex exec --sandbox workspace-write "[引き渡し票]"` で Codex に委譲
       （引き渡し票は Windows 引数長制限のため一時ファイル経由で渡すこと）
     - 「Claude で実装して」→ `feature-dev` サブエージェントで Claude が実装
     - `codex exec` 失敗 → エラーを報告して停止。「Claude でやって」の指示後に `feature-dev` を起動
  3. 明示指示がある場合のみ `acceptance-test` を起動してテスト実行・■■■ 反映
- `codex exec` の並列起動禁止（OAuth 競合）。1 タスクずつ直列実行。
- publish（build / commit / push）は main が下記「publish 手順」に従って直接実行する。
- 要求仕様書の正本は `docs/requirements-usdm.md`。
- 要求・仕様を変えたら `docs/requirements-usdm.md` を更新し、`package.json` の version を揃える。
- アーキテクチャ変更時は `docs/architecture.md` と関連 ADR を確認・更新する。
- 「遅延分離」ポリシー（R-FP-01〜03）を尊重し、全面正規化はしない。

## 必要時に読む詳細

- 要求・仕様変更時: `docs/requirements-usdm.md`
- アーキテクチャ・データモデル・設計制約変更時: `docs/architecture.md` と `docs/adr/`
- エージェント運用判断時: `docs/ai/agent-workflow.md`
- 技術スタック・構成確認時: `docs/ai/project-overview.md`
- リリース・バージョン・公開判断時: `docs/ai/release-policy.md`

## よく使うコマンド

```bash
npm run build
npm test
```

## publish 手順（main が直接実行）

main は以下だけ行う:

1. `git status -sb`
2. `npm run build`
3. `git diff --stat`
4. 必要な変更だけ stage
5. commit
6. push

禁止:

- リポジトリ全体の再調査
- docs 全体の読み直し
- 不要なレビュー
- `npm test` の実行
- 機能コードの編集

## 参照先

- 技術スタック・構成: `docs/ai/project-overview.md`
- エージェント運用詳細: `docs/ai/agent-workflow.md`
- リリース運用: `docs/ai/release-policy.md`
- 要求仕様: `docs/requirements-usdm.md`
- アーキテクチャ: `docs/architecture.md`
