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

## 開発ルール

**コード修正・機能追加・バグ修正など、あらゆる開発タスクは必ず `feature-dev` エージェントを通して行うこと。**

- `feature-dev` がコード修正・仕様書更新・バージョンバンプを一括で行う
- バグ調査が必要な場合は `feature-dev` が `debugger` を呼ぶ
- 開発完了後、「ビルドしてプッシュして」で `publisher` を呼ぶ
- バージョンポリシー: 要件変更あり → マイナーアップ / コード修正のみ → パッチアップ

## エージェント一覧

| エージェント | 役割 |
|---|---|
| `feature-dev` | 開発全部（コード・仕様書・バージョン） |
| `debugger` | バグ調査のみ（読み取り専用） |
| `publisher` | .vsix ビルド＋git push |

## 注意事項

- Marketplace への公開は GitHub Actions が自動で行う（main push 時）
- Mermaid.js はバンドルに含めず media/ に静的配置し Webview から読み込む
