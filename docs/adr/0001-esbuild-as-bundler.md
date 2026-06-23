# ADR 0001: バンドラに esbuild を採用

**日付**: 2026-06-11（初期コミット時点）  
**ステータス**: 採用済み  
**確信度**: 高

---

## コンテキスト

VS Code 拡張機能の Extension Host 側（Node.js）コードを単一ファイル `dist/extension.js` へバンドルする必要がある。拡張機能は TypeScript で記述されており、公開前にビルドが必要。

## 決定

バンドラとして **esbuild** を採用する。`npm run build` → `esbuild.js` を実行し `dist/extension.js` を生成する。

## 理由

esbuild は webpack/rollup と比べてビルド速度が極めて高速であり、VS Code 拡張機能のような比較的単純なバンドル構成（単一エントリポイント・CommonJS 出力）では設定も最小で済む。ウォッチモード（`npm run watch`）も高速に応答する。

**ただし**、esbuild は TypeScript の型チェックを行わない。型安全性が必要な場面では別途 `npx tsc --noEmit` を実行する運用とした。これは速度と型安全のトレードオフとして意識的に選択している。

## 捨てた選択肢

- **webpack**: 設定が複雑になりがち。VS Code 拡張機能のボイラープレートでよく見られるが、ビルド速度が遅い。
- **rollup**: プラグイン構成が必要で esbuild より手間がかかる。
- **tsc のみ**: バンドリングができず、`require` の解決が複雑になる。

## 影響

- 型エラーはビルドを通過してしまうため、CI または手動で `tsc --noEmit` を別途実行する必要がある。
- `_handleExport` の `filters` 由来の strict エラーは既知の無関係エラーとして無視可（CLAUDE.md に明記）。
