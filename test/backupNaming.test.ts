import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backupTimestamp, backupFileName } from '../src/backupNaming';

// R-C09-03/04: コンフリクト退避バックアップの命名・タイムスタンプ純粋ロジック

test('backupTimestamp: ISO を YYYY-MM-DD_HH-MM-SS に変換する', () => {
  const d = new Date('2026-06-20T13:45:09.123Z');
  assert.equal(backupTimestamp(d), '2026-06-20_13-45-09');
});

test('backupTimestamp: コロン・ピリオドを含まずファイル名安全である', () => {
  const stamp = backupTimestamp(new Date('2026-01-02T03:04:05.678Z'));
  assert.ok(!/[:.]/.test(stamp));
  assert.equal(stamp, '2026-01-02_03-04-05');
});

test('backupFileName: mine 側の命名', () => {
  assert.equal(
    backupFileName('/a/b/diagram.md', 'mine', '2026-06-20_13-45-09'),
    'diagram.conflict-mine-2026-06-20_13-45-09.md'
  );
});

test('backupFileName: remote 側の命名', () => {
  assert.equal(
    backupFileName('/a/b/diagram.md', 'remote', '2026-06-20_13-45-09'),
    'diagram.conflict-remote-2026-06-20_13-45-09.md'
  );
});

test('backupFileName: 拡張子なしファイルは拡張子なしで生成する', () => {
  assert.equal(
    backupFileName('/a/b/README', 'mine', '2026-06-20_13-45-09'),
    'README.conflict-mine-2026-06-20_13-45-09'
  );
});

test('backupFileName: 複数ドットのファイルは末尾拡張子のみ尾部に残す', () => {
  assert.equal(
    backupFileName('/a/b/my.diagram.mermaid', 'remote', '2026-06-20_13-45-09'),
    'my.diagram.conflict-remote-2026-06-20_13-45-09.mermaid'
  );
});

test('backupFileName + backupTimestamp: 結合してフルネームを生成できる', () => {
  const stamp = backupTimestamp(new Date('2026-06-20T13:45:09.000Z'));
  assert.equal(
    backupFileName('/dir/chart.md', 'mine', stamp),
    'chart.conflict-mine-2026-06-20_13-45-09.md'
  );
});
