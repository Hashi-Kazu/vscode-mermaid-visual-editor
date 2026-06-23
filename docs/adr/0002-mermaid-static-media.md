# ADR 0002: Mermaid.js を npm バンドルではなく media/ に静的配置

**日付**: 2026-06-11（初期コミット時点）  
**ステータス**: 採用済み  
**確信度**: 高

---

## コンテキスト

Webview 内で Mermaid.js を使ってダイアグラムをレンダリングする必要がある。Mermaid.js を拡張機能のバンドル（`dist/extension.js`）に含める方法と、Webview 側で直接読み込む方法がある。

## 決定

Mermaid.js を `media/mermaid.min.js` として同梱し、Extension Host バンドルには含めない。Webview の HTML から `<script src>` で読み込む。

## 理由

VS Code の Webview は Extension Host（Node.js コンテキスト）とは分離されたブラウザコンテキストで動作する。Extension Host バンドルに含めた JavaScript は Webview からは直接参照できず、`postMessage` 経由で渡すには巨大ペイロードが必要になる。`media/` フォルダのファイルは Webview URI（`webview.asWebviewUri`）で直接参照できるため、静的配置が最もシンプル。

また、esbuild でバンドルすると Mermaid.js のダイナミックな `require` やグローバル依存が壊れるリスクがある。

## 捨てた選択肢

- **npm install mermaid + esbuild バンドル**: Mermaid.js の内部実装がバンドラフレンドリーでない部分があり、動作保証が困難。バンドルサイズも大幅に増加する。
- **CDN 読み込み**: VS Code の Webview は既定でネットワークアクセスを制限するため、オフライン環境での動作が保証できない。

## 影響

- Mermaid.js のバージョン更新は手動で `media/mermaid.min.js` を差し替える作業が必要。
- Mermaid 11 系への移行時に `data-id` によるエッジ特定方法の変更が必要だった（ADR 0006 参照）。
