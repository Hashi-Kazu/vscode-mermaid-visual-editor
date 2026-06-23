# ADR 0003: GanttとFlowchartを単一 EditorPanel に統合

**日付**: 2026-06-14（v1.5.1、commit a88b639）  
**ステータス**: 採用済み  
**確信度**: 高

---

## コンテキスト

v1.5.0 でフローチャートビューアを追加した際、Gantt 用の `GanttPanel` とは別に `FlowchartPanel` として独立実装した。ユーザーがファイルを開くと Gantt パネルと Flowchart パネルが別々に開く可能性があり、重複パネル問題が発生していた。

## 決定

`GanttPanel` と `FlowchartPanel` を廃止し、単一の `EditorPanel`（`src/editorPanel.ts`）に統合する。`EditorPanel` はツールバーのスイッチボタン（↔ Gantt / ↔ フローチャート）で表示ダイアグラム種別を切り替える。

## 理由

コミットメッセージ（a88b639）に明記: "Replace separate GanttPanel/FlowchartPanel with unified EditorPanel that shares one vscode.WebviewPanel, avoiding duplicate panels."

1つの `vscode.WebviewPanel` を共有することで、同一ファイルに対して複数パネルが開く問題が解消される。また、Webview の初期化コスト・HTML 構築ロジック・`postMessage` ハンドリングを一元管理できる。

## 捨てた選択肢

- **パネルを分離したまま排他制御**: 同じファイルに対して別種のパネルが開こうとした場合に既存パネルを再利用する実装も可能だが、状態管理が複雑になる。

## 影響

- 旧 `src/ganttPanel.ts`・`src/flowchartPanel.ts` は廃止。
- `EditorPanel` が Gantt/Flowchart 双方の WebviewPanel ライフサイクルと `postMessage` を管理する。
- 新しいダイアグラム型を追加する際は `EditorPanel` を拡張する（architecture.md §2.1 参照）。
