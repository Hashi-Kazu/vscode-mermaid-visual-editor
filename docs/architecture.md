# Mermaid ビジュアルエディタ アーキテクチャ・設計資料

**文書番号**: MMD-ARCH-001  
**原典バージョン**: 2.4.0（requirements.md §6.1・§8〜§10 から分離）  
**作成日**: 2026-06-19  
**ステータス**: 草稿

---

## 1. 設計原則

### 1.1 SVGオーバーレイ方式（フローチャート）

フローチャートパネルはMermaid.jsが生成するSVGをそのままレンダリングし、その上にインタラクティブUI（クリックハンドラ・ポートハンドル・選択枠）をオーバーレイとして重ねる。ノードの物理的な位置はMermaid.jsのオートレイアウトが決定し、Mermaidコードにカスタム座標を保存しない。これにより`.md`ファイルが標準Mermaid記法を維持する。

### 1.2 MD記述更新ポリシー（遅延分離）

Mermaidは「ノードをエッジ行へインライン記述する形式（`A[開始] --> B{条件}`）」と「ノードを単独行で宣言しエッジはID参照のみとする形式（`A[開始]` / `A --> B`）」の双方を標準としてサポートする。本拡張は後者（分離形式）を**正の更新ポリシー**とする。

**方針**:
- エッジの追加は常にID参照のみで行う（`A --> B` 形式、ノードの囲み記号をエッジ行へ書き込まない）
- ノードのラベル編集・形状変更は、対象ノードを単独宣言行へ集約してから反映する（遅延分離）
- 編集対象でない既存行・サブグラフ・コメントは保持する（全面正規化は行わない）

詳細仕様は要求仕様書 R-FP-01〜03 を参照。

### 1.3 楽観的同時実行制御（コンフリクト検知）

本拡張のGantt／Flowchartビューアはいずれも編集操作のたびにドキュメント全文を再シリアライズして置換する（per-operationマージは行わない）。そのため、書き込みの直前に base スナップショットとライブ／ディスク内容を比較し、並行変更を検知する楽観的同時実行制御を適用する。

- 判定ロジック: VS Code API に依存しない純粋関数として `src/conflictDetection.ts` に分離
- ユニットテスト: `test/conflictDetection.test.ts`（9ケース）
- base 保持: `EditorPanel._baseText`（改行 LF 正規化済み）

### 1.4 アクティブエディタ追従と安全な文書切替

単一 `EditorPanel` は `window.onDidChangeActiveTextEditor` を起点に、対応するGantt／Flowchartテキスト文書へ追従する。追従可否は `mermaid.followActiveEditor`（既定 `true`）で制御する。非対応ソース、対応図を含まないMarkdown、非テキストUIは切替対象外とする。

文書切替は `EditorPanel._requestDocumentSwitch` に集約し、コマンド経由の `createOrShow` も同じ経路を使う。切替要求時は旧Webviewからの新規操作を停止し、既存 `_applyQueue` と、全文置換・テンプレート挿入・明示保存を直列化する `_documentOperationQueue` の完了後に最新の切替要求だけを適用する。両キューの完了後に `_isOperating` とキューを初期化するため、旧文書の処理中状態を途中で隠さない。切替時に文書変更リスナーを再登録し、debounce・baseスナップショット・Ganttキャッシュを破棄してWebviewを再構築する。これにより ADR 0003 の単一パネルと ADR 0006 の全文置換／楽観的同時実行制御を維持したまま、旧文書向け更新が新文書へ混入することを防ぐ。

ビューアから対応ファイルへ切り替えた場合の操作継続性は、`WebviewPanel.onDidChangeViewState` で「直前にビューアがアクティブだった」状態を一回限りのフラグとして記録し、`window.onDidChangeActiveTextEditor` の追従処理で消費する。追従対象外の文書、非テキストUI、または `mermaid.followActiveEditor = false` ではこのフラグを破棄する。フラグ付きで対応文書へ追従した場合だけ、Webview再構築後の `ready` による内容更新が完了してから既存パネルを `reveal(..., false)` し、標準エディタ操作中のファイル切替ではフォーカスを奪わない。

---

## 2. アーキテクチャ概要

### 2.1 共通アーキテクチャ

全ダイアグラム型ビューアは以下のパターンで実装する。新しいダイアグラム型を追加する際はこの構造に沿って対応ファイルを追加する。

```
┌──────────────────────────────────────────────────────────┐
│  VS Code Extension Host (Node.js)                         │
│                                                           │
│  extension.ts ─── コマンド登録・アクティベーション・          │
│                   アクティブテキストエディタ追跡              │
│       │                                                   │
│  [Type]Panel.ts   ─── WebviewPanel 管理                   │
│  [Type]Parser.ts  ─── Mermaidコード → データモデル         │
│  [Type]Serializer.ts ─ データモデル → Mermaidコード        │
│                    │                                      │
│                postMessage / onDidReceiveMessage           │
└──────────────────────────────────────────────────────────┘
                        │
             (Sandboxed iframe)
┌──────────────────────────────────────────────────────────┐
│  Webview (Browser Context)                                │
│                                                           │
│  [type].js  ─── レイアウト計算・描画・操作制御              │
│  [type].css ─── スタイル                                  │
└──────────────────────────────────────────────────────────┘
```

---

## 3. メッセージプロトコル

### 3.1 ガントチャート メッセージプロトコル

ガントチャートは拡張機能でパース済みデータ（`GanttData`）をWebviewに渡す。

| 方向 | タイプ | ペイロード | 用途 |
|------|--------|-----------|------|
| 拡張機能 → Webview | `update` | `{ gantt: GanttData }` | パース済みデータで全体更新 |
| 拡張機能 → Webview | `saved` | `{}` | ファイル保存完了通知 |
| 拡張機能 → Webview | `empty` | `{}` | gantブロック未検出（挿入ボタン表示） |
| Webview → 拡張機能 | `ready` | `{}` | Webview初期化完了通知 |
| Webview → 拡張機能 | `initGantt` | `{}` | 空ファイルへデフォルトテンプレート挿入 |
| Webview → 拡張機能 | `editTask` | `{ si, ti, patch: Partial<GanttTask> }` | タスク変更（移動・リサイズ・名称変更・状態・日程） |
| Webview → 拡張機能 | `addTask` | `{ si, afterTi, task: GanttTask }` | タスク追加 |
| Webview → 拡張機能 | `deleteTask` | `{ si, ti }` | タスク削除 |
| Webview → 拡張機能 | `editSection` | `{ si, name: string }` | セクション名変更 |
| Webview → 拡張機能 | `addSection` | `{ name: string }` | セクション追加 |
| Webview → 拡張機能 | `structuralEdit` | `{ gantt: GanttData }` | 構造編集（並び替え・削除・Undo・複製等）をデータ全体で反映 |
| Webview → 拡張機能 | `switchType` | `{ diagramType: 'gantt' \| 'flowchart' }` | ビューア種別の切替 |
| Webview → 拡張機能 | `save` | `{}` | ファイル保存要求（Ctrl+S） |

> 注: タスク・セクションのインデックスはペイロード上 `si`（section index）・`ti`（task index）・`afterTi` として送出する。

### 3.2 フローチャート メッセージプロトコル

フローチャートは「SVGオーバーレイ方式」を採用するため、拡張機能はパース済みデータではなく**生のMermaidコード（`rawCode`）**をWebviewに渡し、Webview側がMermaid.jsで描画する。各編集操作は文字列レベルでコードを書き換える。

| 方向 | タイプ | ペイロード | 用途 |
|------|--------|-----------|------|
| 拡張機能 → Webview | `update` | `{ rawCode: string, isDark: boolean }` | 生コード＋テーマで全体更新 |
| 拡張機能 → Webview | `saved` | `{}` | ファイル保存完了通知 |
| 拡張機能 → Webview | `empty` | `{}` | flowchartブロック未検出（挿入ボタン表示） |
| 拡張機能 → Webview | `parseError` | `{ message: string }` | パースエラー詳細の表示 |
| 拡張機能 → Webview | `startEditNode` | `{ nodeId }` | ノード追加直後のインライン編集起動 |
| Webview → 拡張機能 | `ready` | `{}` | Webview初期化完了通知 |
| Webview → 拡張機能 | `initFlowchart` | `{}` | 空ファイルへデフォルトテンプレート挿入 |
| Webview → 拡張機能 | `editNode` | `{ nodeId, label: string }` | ノードラベル変更 |
| Webview → 拡張機能 | `addNode` | `{ x?, y? }` | ノード追加 |
| Webview → 拡張機能 | `deleteNode` | `{ nodeId }` | ノード削除（関連エッジも連動） |
| Webview → 拡張機能 | `changeNodeShape` | `{ nodeId, shape: NodeShape }` | ノードシェイプ変更（US-F08） |
| Webview → 拡張機能 | `addEdge` | `{ from, to }` | エッジ追加 |
| Webview → 拡張機能 | `editEdge` | `{ from, to, idx, label: string }` | エッジラベル変更 |
| Webview → 拡張機能 | `deleteEdge` | `{ from, to, idx }` | エッジ削除 |
| Webview → 拡張機能 | `changeEdgeStyle` | `{ from, to, idx, style: EdgeStyle }` | エッジタイプ変更（US-F09） |
| Webview → 拡張機能 | `changeDirection` | `{ direction: string }` | グラフ方向変更 |
| Webview → 拡張機能 | `export` | `{ format: 'svg' \| 'png', data: string }` | SVG/PNGエクスポート（US-C06） |
| Webview → 拡張機能 | `switchType` | `{ diagramType: 'gantt' \| 'flowchart' }` | ビューア種別の切替 |
| Webview → 拡張機能 | `undo` | `{ code: string }` | Undo: スナップショットコードで上書き |
| Webview → 拡張機能 | `save` | `{}` | ファイル保存要求（Ctrl+S） |

> 注: エッジは `from` / `to` と、同一ノード対の中での出現順 `idx` で一意に識別する。

---

## 4. データモデル

### 4.1 ガントチャート データモデル

```typescript
interface GanttData {
  title: string;
  dateFormat: string;        // 例: "YYYY-MM-DD"
  axisFormat?: string;       // 例: "%m/%d"
  sections: GanttSection[];
}

interface GanttSection {
  name: string;              // セクション名（セクションなしの場合は空文字）
  tasks: GanttTask[];
}

interface GanttTask {
  id: string;                // タスクID（省略時は自動付番）
  label: string;             // 表示ラベル
  status: 'done' | 'active' | 'crit' | 'milestone' | '';
  startDate: string;         // 絶対日付（dateFormat準拠）
  duration: number;          // 日数
  afterId?: string;          // 依存関係: `after <id>`（US-G11）
}
```

### 4.2 フローチャート データモデル

```typescript
type NodeShape = 'rect' | 'round' | 'diamond' | 'stadium' | 'circle';

type EdgeStyle =
  | 'solid-arrow'      // A --> B
  | 'dotted-arrow'     // A -.-> B
  | 'thick-arrow'      // A ==> B
  | 'solid-no-arrow'   // A --- B
  | 'dotted-no-arrow'; // A -.- B

interface FlowchartData {
  direction: 'TD' | 'LR' | 'BT' | 'RL';
  keyword: 'flowchart' | 'graph';
  nodes: FlowchartNode[];
  edges: FlowchartEdge[];
}

interface FlowchartNode {
  id: string;
  label: string;
  shape: NodeShape;          // US-F08
}

interface FlowchartEdge {
  id: string;                // `${from}::${to}::${idx}` 形式の内部識別子
  from: string;
  to: string;
  label?: string;
  style?: EdgeStyle;         // US-F09
}
```

---

## 5. ファイル構成

### 5.1 共通ファイル

GanttとFlowchartは単一の`EditorPanel`（`src/editorPanel.ts`）を共有し、ツールバーの切替ボタンで表示を切り替える（R-F01-02）。

```
vscode-mermaid-visual-editor/
├── .vscode/
│   └── launch.json
├── src/
│   ├── extension.ts         ← コマンド登録・アクティベーション
│   ├── editorPanel.ts       ← Gantt/Flowchart共有のWebviewPanel管理・コンフリクト検知/解決
│   ├── conflictDetection.ts ← 楽観的同時実行制御の純粋ロジック（base比較・改行正規化・テスト対象）
│   └── types.ts             ← 共通型定義
├── media/
│   └── icon.png
├── snippets/
│   └── mermaid.json
├── syntaxes/
│   └── mermaid.tmLanguage.json
├── test/                    ← パーサ/シリアライザ/コンフリクト検知のユニットテスト（node --test）
│   ├── serializers.test.ts
│   ├── parsers.test.ts
│   └── conflictDetection.test.ts
├── docs/
│   ├── requirements.md
│   ├── requirements-usdm.md
│   ├── architecture.md
│   └── acceptance-tests.md
├── dist/
├── package.json
├── tsconfig.json
├── esbuild.js
└── CLAUDE.md
```

### 5.2 ガントチャート固有ファイル

```
├── src/
│   ├── ganttParser.ts       ← Mermaidコード → GanttData
│   └── ganttSerializer.ts   ← GanttData → Mermaidコード
└── media/
    ├── gantt.js             ← Webview側スクリプト（描画・操作制御）
    └── gantt.css            ← スタイル
```

> WebviewPanel管理は共通の `editorPanel.ts` が担う（旧 `ganttPanel.ts` はv2.0で統合・廃止）。

### 5.3 フローチャート固有ファイル

```
├── src/
│   ├── flowchartParser.ts   ← Mermaidコード → FlowchartData
│   └── flowchartSerializer.ts ← FlowchartData → Mermaidコード（文字列レベルの編集操作）
└── media/
    ├── flowchart.js         ← Webview側スクリプト（SVGオーバーレイ・操作制御）
    └── flowchart.css        ← スタイル
```

> WebviewPanel管理は共通の `editorPanel.ts` が担う（旧 `flowchartPanel.ts` はv2.0で統合・廃止）。

---

## 6. 実装メモ

### 6.1 コード地図

- `src/editorPanel.ts`: Gantt/Flowchart 共有の WebviewPanel 管理・安全な文書切替・双方向同期・全文置換書き込み・コンフリクト検知/解決（`_requestDocumentSwitch` / `_runDocumentOperation` / `_writeDocument` / `_doWrite` / `_doApplyGanttData` / `_applyQueue` / `_documentOperationQueue` / `_isOperating`）
- パース/シリアライズ: `src/{gantt,flowchart}{Parser,Serializer}.ts`
- Webview 側操作: `media/{gantt,flowchart}.js`（バンドル対象外で素のまま配信）
- テスト対象純粋ロジック: `src/conflictDetection.ts`

### 6.2 ビルド・検証

```bash
npm run build     # 開発ビルド → dist/（esbuild）
npm run package   # .vsix 生成（vsce package）
npm run watch     # ウォッチモード
npm test          # ユニットテスト（node --test）
```

- esbuild は型チェックしないため、型が不安な場合は `npx tsc --noEmit -p tsconfig.json` を実行する
- `_handleExport` の filters 由来の strict エラーは既知・無関係につき無視可

### 6.3 制約・注意事項

- Marketplace への公開は GitHub Actions が自動で行う（main push 時）
- Mermaid.js はバンドルに含めず `media/` に静的配置し Webview から読み込む
- 「遅延分離」ポリシー（R-FP-01〜03）を尊重し、全面正規化はしない

---
