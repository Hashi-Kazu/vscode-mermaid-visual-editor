// VS Code 非依存の、コンフリクト退避バックアップ命名ロジック（純粋関数）。
// ファイル I/O（writeFile）や Uri 生成は呼び出し側に残し、ここでは
// タイムスタンプ生成と命名規則の組み立てのみを扱う。

import * as path from 'path';

export type ConflictSide = 'mine' | 'remote';

/**
 * Date を "YYYY-MM-DD_HH-MM-SS" 形式のファイル名安全なスタンプに変換する。
 * ISO 文字列の ':' と '.' を '-' に、'T' を '_' に置換し、秒までで切り詰める。
 * 例: 2026-06-20T13:45:09.123Z -> "2026-06-20_13-45-09"
 */
export function backupTimestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19);
}

/**
 * コンフリクト退避用のバックアップファイル名を生成する。
 * 元ファイル名（ベース）と拡張子の間に ".conflict-<which>-<stamp>" を挿入する。
 * 例: "diagram.md" + "mine" -> "diagram.conflict-mine-2026-06-20_13-45-09.md"
 *
 * 拡張子が無いファイル（"README" 等）の場合は拡張子なしで生成される。
 */
export function backupFileName(sourcePath: string, which: ConflictSide, stamp: string): string {
  const ext = path.extname(sourcePath);
  const base = path.basename(sourcePath, ext);
  return `${base}.conflict-${which}-${stamp}${ext}`;
}
