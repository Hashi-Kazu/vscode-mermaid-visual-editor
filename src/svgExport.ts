// VS Code 非依存の SVG/PNG エクスポート純粋ロジック。
// DOM 依存の SVG クリーニング（cloneNode / querySelectorAll / XMLSerializer）は
// Webview 側（media/flowchart.js の serializeCleanSvg）に残し、ここでは
// 「出力ファイル名の導出」と「データのバイト符号化方式の決定」のみを扱う。

export type ExportFormat = 'svg' | 'png';

/**
 * エクスポート先のデフォルトファイルパスを導出する。
 * 元ドキュメントのパスから末尾拡張子を除去し、フォーマットの拡張子を付与する。
 * 例: "/a/b/diagram.md" + "svg" -> "/a/b/diagram.svg"
 *
 * 拡張子が無い場合はそのまま付与する（"/a/b/diagram" -> "/a/b/diagram.png"）。
 */
export function exportDefaultPath(sourcePath: string, format: ExportFormat): string {
  const baseName = sourcePath.replace(/\.[^.]+$/, '');
  return `${baseName}.${format}`;
}

/**
 * エクスポートデータを書き込み用バイト列のエンコード情報に変換する。
 * SVG はテキスト（utf-8）、PNG は base64 デコードして書き込む。
 *
 * Buffer 生成自体は呼び出し側（Node 環境）が行えるよう、
 * ここでは入力文字列とエンコーディング種別のみを純粋に判定して返す。
 */
export function exportEncoding(format: ExportFormat): 'utf-8' | 'base64' {
  return format === 'svg' ? 'utf-8' : 'base64';
}
