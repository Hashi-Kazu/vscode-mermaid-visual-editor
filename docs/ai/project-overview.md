# Project Overview

## 概要

VS Code 拡張機能。Mermaid 記法の図をリアルタイムプレビュー・編集する。TypeScript + esbuild + VS Code API 構成。

## 技術スタック

- TypeScript + esbuild
- VS Code Extension API（`@types/vscode` ^1.85.0）
- Mermaid.js（`media/mermaid.min.js` として同梱）
- エントリポイント: `src/extension.ts`
- ビルド出力: `dist/extension.js`

## コマンド

```bash
npm run build     # 開発ビルド -> dist/
npm run watch     # ウォッチモード
npm test          # Node test
```

## ディレクトリ構成

```text
src/              # TypeScript ソース
docs/             # 要求仕様書
media/            # アイコン・CSS・JS（Webview側）
snippets/         # スニペット定義
syntaxes/         # TextMate文法
dist/             # ビルド出力（自動生成）
```

## 実装メモ

- `src/editorPanel.ts` が Gantt / Flowchart 共有の WebviewPanel 管理、双方向同期、全文置換書き込み、コンフリクト検知/解決を担当する。
- パース/シリアライズは `src/{gantt,flowchart}{Parser,Serializer}.ts`。
- Webview 側操作は `media/{gantt,flowchart}.js`。バンドル対象外で素のまま配信する。
- テストしたい純粋ロジックは `src/` に置く（例: `src/conflictDetection.ts`）。
- Mermaid.js はバンドルに含めず、`media/` に静的配置して Webview から読み込む。
