# vscode-mermaid-visual-editor

VS Code extension for Mermaid diagram preview and editing. TypeScript + esbuild + VS Code API.

## 必須ルール

- 自明な修正（typo・1〜2行・設定値変更）はmainが直接対応する。
- 非自明なタスクはmainが調査せず、`planner` に調査・仕様策定・引き渡し票生成を依頼する。
- mainはplanner票を編集・要約せず実装担当へ渡す。デフォルトは `codex exec --sandbox workspace-write`、ユーザーが明示した場合だけClaudeの `feature-dev` を使う。
- `codex exec` 失敗時は停止して報告する。自動でClaude実装へ切り替えない。Codexは並列起動しない。
- 受け入れテストは明示指示時のみ `acceptance-test` を使い、planner票をそのまま渡す。
- 受け入れテストだけを行う場合、対象仕様または機能が分かればplannerにテスト票を作らせる。完全なテスト票が提示済みならplannerを省略する。対象不明なら全件走査せずユーザーへ確認する。実装担当は起動しない。
- テストFAILが実装バグなら報告を添えてCodexへ戻し、設計・仕様の問題だけplannerへ戻す。
- publishはmainが `docs/ai/release-policy.md` だけを追加参照して実行する。
- 要求仕様書の正本は `docs/requirements-usdm.md`。要件変更時は仕様書とversionを揃え、アーキテクチャ変更時は `docs/architecture.md` と関連ADRを更新する。
- 「遅延分離」ポリシー（R-FP-01〜03）を尊重し、全面正規化はしない。

## 必要時に読む文書

- 技術スタック・構成: `docs/ai/project-overview.md`
- エージェント運用: `docs/ai/agent-workflow.md`
- リリース: `docs/ai/release-policy.md`
- 要求仕様: `docs/requirements-usdm.md`
- アーキテクチャ: `docs/architecture.md`、`docs/adr/`
