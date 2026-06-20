import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportDefaultPath, exportEncoding } from '../src/svgExport';

// R-C06-01〜04: SVG/PNG エクスポート出力パス・符号化方式の純粋ロジック

test('exportDefaultPath: .md を svg 拡張子に差し替える', () => {
  assert.equal(exportDefaultPath('/a/b/diagram.md', 'svg'), '/a/b/diagram.svg');
});

test('exportDefaultPath: .md を png 拡張子に差し替える', () => {
  assert.equal(exportDefaultPath('/a/b/diagram.md', 'png'), '/a/b/diagram.png');
});

test('exportDefaultPath: 既存拡張子が同種でも上書きする', () => {
  assert.equal(exportDefaultPath('/x/chart.svg', 'png'), '/x/chart.png');
});

test('exportDefaultPath: 拡張子なしファイルはそのまま付与する', () => {
  assert.equal(exportDefaultPath('/x/chart', 'svg'), '/x/chart.svg');
});

test('exportDefaultPath: Windows パスでも末尾拡張子のみ置換する', () => {
  assert.equal(
    exportDefaultPath('C:\\docs\\my.diagram.mermaid', 'svg'),
    'C:\\docs\\my.diagram.svg'
  );
});

test('exportEncoding: svg はテキスト utf-8', () => {
  assert.equal(exportEncoding('svg'), 'utf-8');
});

test('exportEncoding: png は base64', () => {
  assert.equal(exportEncoding('png'), 'base64');
});

test('exportEncoding: 実際の Buffer 化と整合する（svg=平文 / png=base64 復号）', () => {
  const svg = '<svg></svg>';
  assert.equal(Buffer.from(svg, exportEncoding('svg')).toString('utf-8'), svg);

  const original = 'PNG-bytes';
  const b64 = Buffer.from(original, 'utf-8').toString('base64');
  assert.equal(Buffer.from(b64, exportEncoding('png')).toString('utf-8'), original);
});
