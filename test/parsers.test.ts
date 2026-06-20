import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFlowchart } from '../src/flowchartParser';
import { parseGantt } from '../src/ganttParser';

test('parseFlowchart detects keyword, direction and node shapes', () => {
  const code = '```mermaid\nflowchart LR\n    A[四角] --> B{ひし}\n    C([スタジアム])\n    D((円))\n    E(丸)\n```';
  const data = parseFlowchart(code)!;
  assert.ok(data);
  assert.equal(data.keyword, 'flowchart');
  assert.equal(data.direction, 'LR');
  const byId = Object.fromEntries(data.nodes.map(n => [n.id, n.shape]));
  assert.equal(byId.A, 'rect');
  assert.equal(byId.B, 'diamond');
  assert.equal(byId.C, 'stadium');
  assert.equal(byId.D, 'circle');
  assert.equal(byId.E, 'round');
});

test('parseFlowchart normalizes TB to TD and keeps graph keyword', () => {
  const data = parseFlowchart('graph TB\n    A --> B')!;
  assert.equal(data.keyword, 'graph');
  assert.equal(data.direction, 'TD');
});

test('parseFlowchart captures edge styles and labels', () => {
  const data = parseFlowchart('flowchart TD\n    A -->|yes| B\n    B -.-> C\n    C ==> D')!;
  const styles = data.edges.map(e => e.style);
  assert.deepEqual(styles, ['solid-arrow', 'dotted-arrow', 'thick-arrow']);
  assert.equal(data.edges[0].label, 'yes');
});

test('parseFlowchart returns null when no flowchart header', () => {
  assert.equal(parseFlowchart('```mermaid\ngantt\n    title X\n```'), null);
});

test('parseGantt parses sections, tasks and dependencies', () => {
  const code = '```mermaid\ngantt\n    title スケジュール\n    dateFormat YYYY-MM-DD\n    section S1\n        T1 :t1, 2026-01-01, 3d\n        T2 :after t1, 2d\n```';
  const data = parseGantt(code)!;
  assert.ok(data);
  assert.equal(data.title, 'スケジュール');
  const tasks = data.sections.flatMap(s => s.tasks);
  assert.equal(tasks[0].label, 'T1');
  assert.equal(tasks[0].duration, 3);
  assert.equal(tasks[1].afterId, 't1');
});

test('parseGantt returns null for non-gantt content', () => {
  assert.equal(parseGantt('```mermaid\nflowchart TD\n    A --> B\n```'), null);
});

// ── Section name round-trip ──────────────────────────────────────────────────

test('parseGantt round-trip preserves section name after rename', () => {
  // Simulate section rename: serialize with new name, then re-parse.
  // This guards against the bug where section name changes were not reflected.
  const code = 'gantt\n    dateFormat YYYY-MM-DD\n\n    section 旧セクション名\n        T1 :2026-01-01, 3d\n';
  const data = parseGantt(code)!;
  // Rename the section
  data.sections[0].name = '新しいセクション名';
  // Re-serialize and re-parse
  const { ganttToCode } = require('../src/ganttSerializer');
  const newCode = ganttToCode(data);
  const reparsed = parseGantt(newCode)!;
  assert.equal(reparsed.sections[0].name, '新しいセクション名');
  assert.equal(reparsed.sections[0].tasks[0].label, 'T1');
});

// ── crit keyword parsing ──────────────────────────────────────────────────────

test('parseGantt parses standalone crit keyword as crit flag', () => {
  const code = 'gantt\n    dateFormat YYYY-MM-DD\n    section S\n        T1 :crit, t1, 2026-01-01, 5d\n';
  const data = parseGantt(code)!;
  const task = data.sections[0].tasks[0];
  assert.equal(task.crit, true);
  assert.equal(task.status, '');
  assert.equal(task.id, 't1');
  assert.equal(task.duration, 5);
});

test('parseGantt parses crit combined with done status', () => {
  const code = 'gantt\n    dateFormat YYYY-MM-DD\n    section S\n        T1 :crit, done, t1, 2026-01-01, 3d\n';
  const data = parseGantt(code)!;
  const task = data.sections[0].tasks[0];
  assert.equal(task.crit, true);
  assert.equal(task.status, 'done');
  assert.equal(task.id, 't1');
});

test('parseGantt parses done then crit (reversed order)', () => {
  const code = 'gantt\n    dateFormat YYYY-MM-DD\n    section S\n        T1 :done, crit, 2026-01-01, 7d\n';
  const data = parseGantt(code)!;
  const task = data.sections[0].tasks[0];
  assert.equal(task.crit, true);
  assert.equal(task.status, 'done');
});

test('parseGantt does not set crit flag when keyword absent', () => {
  const code = 'gantt\n    dateFormat YYYY-MM-DD\n    section S\n        T1 :done, t1, 2026-01-01, 3d\n';
  const data = parseGantt(code)!;
  const task = data.sections[0].tasks[0];
  assert.equal(task.crit, undefined);
  assert.equal(task.status, 'done');
});
