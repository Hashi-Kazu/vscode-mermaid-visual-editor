# ADR 0008: Webview 側スクリプト（media/*.js）をバンドル対象外で素のまま配信

**日付**: 2026-06-11（初期コミット時点）  
**ステータス**: 採用済み  
**確信度**: 高

---

## コンテキスト

VS Code 拡張機能のアーキテクチャは「Extension Host（Node.js コンテキスト）」と「Webview（ブラウザコンテキスト）」の2層に分かれる。Extension Host 側は esbuild でバンドルするが、Webview 側のスクリプト（`media/gantt.js`、`media/flowchart.js`）をどう扱うかを決定する必要がある。

## 決定

`media/gantt.js` と `media/flowchart.js` は **esbuild のバンドル対象に含めず**、`media/` に素のまま配置し、Webview の HTML から `<script src>` で直接読み込む。

## 理由

Webview スクリプトはブラウザ環境で実行されるため、CommonJS の `require` や Node.js 固有 API を使用しない。モジュール分割の必要性が低く、バンドルのメリットが薄い。

バンドルに含めると：
- Webview URI（`webview.asWebviewUri`）でのファイル参照ができなくなる
- バンドルとは別の Webview 向けビルドパイプラインが必要になる
- `mermaid.min.js` との読み込み順序の管理が複雑になる

`media/` フォルダのファイルはそのまま Webview に公開可能（CSP で `src` 許可）なため、素のまま配信が最もシンプル。

## 捨てた選択肢

- **Webview 専用のバンドルパイプライン追加**: 設定ファイルが増え、ビルド手順が複雑になる。Webview スクリプトが単一ファイルで完結している現状では過剰。
- **Extension Host バンドルに含めて postMessage で渡す**: 巨大ペイロードを毎回送ることになり非現実的。

## 影響

- `media/gantt.js` と `media/flowchart.js` は TypeScript でなく素の JavaScript で記述する。
- `npm run build` では `media/` 以下は変更されない。
- ファイルが多くなった場合は Webview 専用バンドルを検討する価値がある（現状は 2 ファイルのみ）。
