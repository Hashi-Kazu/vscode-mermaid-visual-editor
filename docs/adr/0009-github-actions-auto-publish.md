# ADR 0009: Marketplace 公開を GitHub Actions で自動化

**日付**: 2026-06-11（commit d4a41c3）  
**ステータス**: 採用済み  
**確信度**: 高

---

## コンテキスト

VS Code 拡張機能を Marketplace に公開するには `vsce publish` コマンドが必要。手動で実行する方法と CI/CD パイプラインで自動化する方法がある。

## 決定

**GitHub Actions** を使い、`main` ブランチへの push 時に自動で `.vsix` ビルドおよび Marketplace 公開を行う（`.github/workflows/publish.yml`）。開発フロー上の `publisher` エージェントは `git push` まで担当し、Marketplace へのアップロードは GitHub Actions が引き継ぐ。

## 理由

コミット（d4a41c3）に GitHub Actions ワークフローを追加した記録あり。CI/CD 自動化の主な理由：

1. 公開トークン（Personal Access Token）をローカル開発環境に持たせず、GitHub Secrets で管理することでセキュリティを確保する。
2. 公開手順を自動化し、バージョンバンプ＆プッシュだけで公開が完了するフローを実現する（手順ミス防止）。
3. 複数マシン・複数エージェントが開発に関わる体制（Claude Code エージェント利用）では、公開権限を一元管理できる。

## 捨てた選択肢

- **手動 vsce publish**: トークン管理が各開発者に必要。エージェントが公開まで担当する場合のトークン受け渡しが複雑。

## 影響

- `publisher` エージェントの責務は「`.vsix` ビルド確認 → commit → push」まで。Marketplace へのアップロードは GitHub Actions が行うため、エージェントから直接 `vsce publish` は実行しない。
- バージョン番号は `package.json` で管理し、push 時に GitHub Actions が検出して公開する。
- `vscode-mindmap-editor` リポジトリのワークフロー構成を参考に整備（memory: project_github_setup.md 参照）。
