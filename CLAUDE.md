# vscode-mermaid-visual-editor

VS Code拡張機能。TypeScript + esbuild + VS Code API 構成。

## 技術スタック

- TypeScript + esbuild
- VS Code Extension API（@types/vscode ^1.85.0）
- Mermaid.js（media/mermaid.min.js として同梱）
- エントリポイント: `src/extension.ts`
- ビルド出力: `dist/extension.js`

## コマンド

```bash
npm run build     # 開発ビルド → dist/
npm run package   # .vsix 生成（vsce package）
npm run watch     # ウォッチモード
```

## ディレクトリ構成

```
src/              # TypeScript ソース
docs/             # 要求仕様書
media/            # アイコン・CSS・JS（Webview側）
snippets/         # スニペット定義
syntaxes/         # TextMate文法
dist/             # ビルド出力（自動生成）
```

## 注意事項

- Marketplace への公開は GitHub Actions が自動で行う（main push 時）
- Mermaid.js はバンドルに含めず media/ に静的配置し Webview から読み込む
