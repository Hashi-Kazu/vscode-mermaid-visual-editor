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

- `feature-dev` がコード修正・仕様書更新（ステータス `■■□`）・バージョンバンプ・受け入れテスト更新を一括で行う
- バグ調査が必要な場合は `debugger` を呼ぶ（**すべてのエージェント起動は main が行う**。サブエージェント間で直接指示はできない）
- **開発完了後の自動フロー**（すべて main が順に起動する）:
  1. `feature-dev` が成功報告（lint/build 通過、ステータス `■■□` 更新済み）
  2. **受け入れテストはユーザーから明示的に指示があった場合のみ実行する。** 指示がない場合はスキップして手順 3 へ進む。実行する場合: main が `acceptance-test` を起動 → テスト実行・ステータス `■■■` 反映・結果返却
     - **FAIL あり**: main が `feature-dev` を再起動して修正させる（FAIL 詳細を渡す）
     - **PASS / SKIP のみ**: 手順 3 へ進む
  3. main が `publisher` を起動 → .vsix ビルド〜commit〜push まで完了
  - 停止するケース: `feature-dev` が失敗・中断、または「`debugger` 必要」と報告した場合は以降を起動せず停止して報告する
  - 最終ゲート（バージョン整合・lint/build 失敗時は push せず停止）は `publisher` 側で従来どおり機能する
- バージョンポリシー: 要件変更あり → マイナーアップ / コード修正のみ → パッチアップ
- **`feature-dev` はテストを実行しない**（`npm test` 等の実行は `acceptance-test` の責務。テストコードの更新・追加は行ってよいが、実行はしない）

## エージェント一覧

| エージェント | 役割 |
|---|---|
| `feature-dev` | 開発全部（コード・仕様書・バージョン・受け入れテスト更新） |
| `debugger` | バグ調査のみ（読み取り専用） |
| `acceptance-test` | 受け入れテスト実行・ステータス `■■■` 反映 |
| `publisher` | .vsix ビルド＋git push |

> **エージェント定義の管理**: `.claude/agents/*.md` は `C:\Claude Code\_agent-templates`（正本）から同期されたコピー。**直接編集せず**、正本を編集して `_agent-templates\sync-agents.ps1` を実行すること（直接編集は次回同期で上書きされる）。プロジェクト固有の事情はエージェントではなくこの CLAUDE.md に書く。

## 実装メモ（feature-dev / debugger 向け）

- **コード地図**: `src/editorPanel.ts` が Gantt/Flowchart 共有の WebviewPanel 管理・双方向同期・全文置換書き込み・コンフリクト検知/解決（`_writeDocument` / `_doWrite` / `_doApplyGanttData` / `_applyQueue` / `_isOperating`）。パース/シリアライズは `src/{gantt,flowchart}{Parser,Serializer}.ts`。Webview 側操作は `media/{gantt,flowchart}.js`（バンドル対象外で素のまま配信）。テストしたい純粋ロジックは `src/` に置く（例 `src/conflictDetection.ts`）。
- **検証**: `npm run build`（esbuild）と `npm test`。esbuild は型チェックしないので、型が不安なら `npx tsc --noEmit -p tsconfig.json`。ただし `_handleExport` の filters 由来の strict エラーは既知・無関係で無視可。
- 「遅延分離」ポリシー（要求仕様書 R-FP-01〜03）を尊重し、全面正規化はしない。

## アーキテクチャ判断

重要な設計判断は `docs/adr/` に記録されている。
新機能実装や既存コードの変更前に、関連する ADR を確認すること。

## 注意事項

- Marketplace への公開は GitHub Actions が自動で行う（main push 時。`publisher` は push まで担当）
- Mermaid.js はバンドルに含めず media/ に静的配置し Webview から読み込む
