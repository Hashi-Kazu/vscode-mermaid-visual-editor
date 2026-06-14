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
