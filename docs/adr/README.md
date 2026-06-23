# Architecture Decision Records (ADR)

本ディレクトリは `vscode-mermaid-visual-editor` の重要な設計判断を [MADR](https://adr.github.io/madr/) 形式で記録したものです。

新機能実装や既存コードの変更前に、関連する ADR を確認してください。

---

## 一覧

| 番号 | タイトル | 確信度 | 一行要約 |
|------|----------|--------|----------|
| [0001](0001-esbuild-as-bundler.md) | バンドラに esbuild を採用 | 高 | webpack/rollup より高速。型チェックは別途 tsc --noEmit で行う |
| [0002](0002-mermaid-static-media.md) | Mermaid.js を media/ に静的配置 | 高 | Webview から直接読み込むため npm バンドルに含めない |
| [0003](0003-unified-editor-panel.md) | GanttとFlowchartを単一 EditorPanel に統合 | 高 | 重複パネル問題を解消。旧 GanttPanel/FlowchartPanel は廃止 |
| [0004](0004-flowchart-svg-overlay.md) | フローチャートに SVGオーバーレイ方式を採用 | 高 | ノード座標を保存せず、標準 Mermaid 記法を維持する |
| [0005](0005-delayed-separation-policy.md) | MD記述の更新ポリシーを「遅延分離」に統一 | 高 | 全面正規化せず編集ノードだけをその場で分離形式に変換 |
| [0006](0006-optimistic-concurrency-control.md) | 全文置換書き込みに楽観的同時実行制御を適用 | 高 | base スナップショット比較でコンフリクトを検知・モーダル解決 |
| [0007](0007-pure-function-conflict-detection.md) | コンフリクト検知ロジックを純粋関数として分離 | 高 | VS Code 非依存で unit test 可能に。src/conflictDetection.ts |
| [0008](0008-webview-scripts-not-bundled.md) | Webview スクリプトをバンドル対象外で配信 | 高 | media/*.js は esbuild を通さず素のまま Webview に配信 |
| [0009](0009-github-actions-auto-publish.md) | Marketplace 公開を GitHub Actions で自動化 | 高 | main push 時に自動公開。publisher エージェントは push まで担当 |

---

## 要確認項目

なし（全 ADR の確信度が高く、コミット履歴・仕様書・コードコメントに根拠あり）

---

## 新しい ADR を追加するには

1. 次の連番（`0010-xxx.md`）でファイルを作成
2. `docs/adr/` の既存ファイルをテンプレートとして使用
3. この README の一覧に追記
