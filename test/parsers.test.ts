import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFlowchart, getFlowchartBlock } from '../src/flowchartParser';
import { parseGantt, parseDate, fmt } from '../src/ganttParser';

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

// ── milestone keyword parsing ─────────────────────────────────────────────────

test('parseGantt parses milestone keyword as status milestone', () => {
  const code = 'gantt\n    dateFormat YYYY-MM-DD\n    section S\n        M1 :milestone, m1, 2026-03-01, 0d\n';
  const data = parseGantt(code)!;
  const task = data.sections[0].tasks[0];
  assert.equal(task.status, 'milestone');
  assert.equal(task.crit, undefined);
  assert.equal(task.id, 'm1');
});

test('parseGantt parses milestone + crit combination', () => {
  const code = 'gantt\n    dateFormat YYYY-MM-DD\n    section S\n        M1 :crit, milestone, m1, 2026-03-01, 0d\n';
  const data = parseGantt(code)!;
  const task = data.sections[0].tasks[0];
  assert.equal(task.status, 'milestone');
  assert.equal(task.crit, true);
  assert.equal(task.id, 'm1');
});

// ── active status parsing ─────────────────────────────────────────────────────

test('parseGantt parses active status', () => {
  const code = 'gantt\n    dateFormat YYYY-MM-DD\n    section S\n        T1 :active, a1, 2026-02-01, 5d\n';
  const data = parseGantt(code)!;
  const task = data.sections[0].tasks[0];
  assert.equal(task.status, 'active');
  assert.equal(task.crit, undefined);
  assert.equal(task.id, 'a1');
  assert.equal(task.duration, 5);
});

test('parseGantt parses active + crit combination', () => {
  const code = 'gantt\n    dateFormat YYYY-MM-DD\n    section S\n        T1 :active, crit, a1, 2026-02-01, 3d\n';
  const data = parseGantt(code)!;
  const task = data.sections[0].tasks[0];
  assert.equal(task.status, 'active');
  assert.equal(task.crit, true);
});

// ── axisFormat / title parsing ────────────────────────────────────────────────

test('parseGantt parses axisFormat directive', () => {
  const code = 'gantt\n    dateFormat YYYY-MM-DD\n    axisFormat %m/%d\n    section S\n        T1 :2026-01-01, 2d\n';
  const data = parseGantt(code)!;
  assert.equal(data.axisFormat, '%m/%d');
});

test('parseGantt parses title directive with Japanese text', () => {
  const code = 'gantt\n    title プロジェクト計画\n    dateFormat YYYY-MM-DD\n    section S\n        T1 :2026-01-01, 2d\n';
  const data = parseGantt(code)!;
  assert.equal(data.title, 'プロジェクト計画');
});

test('parseGantt returns undefined axisFormat when directive is absent', () => {
  const code = 'gantt\n    dateFormat YYYY-MM-DD\n    section S\n        T1 :2026-01-01, 2d\n';
  const data = parseGantt(code)!;
  assert.equal(data.axisFormat, undefined);
});

// ── root-level tasks (no section) ─────────────────────────────────────────────

test('parseGantt places pre-section tasks in leading unnamed section', () => {
  const code = 'gantt\n    dateFormat YYYY-MM-DD\n    T1 :t1, 2026-01-01, 3d\n    T2 :t2, 2026-01-04, 2d\n';
  const data = parseGantt(code)!;
  // Tasks without a preceding section line land in the implicit leading section.
  assert.equal(data.sections.length, 1);
  assert.equal(data.sections[0].name, '');
  assert.equal(data.sections[0].tasks.length, 2);
  assert.equal(data.sections[0].tasks[0].label, 'T1');
  assert.equal(data.sections[0].tasks[1].label, 'T2');
});

// ── no-arrow edge styles ──────────────────────────────────────────────────────

test('parseFlowchart parses solid-no-arrow edge (A --- B)', () => {
  const data = parseFlowchart('flowchart TD\n    A --- B')!;
  assert.equal(data.edges.length, 1);
  assert.equal(data.edges[0].style, 'solid-no-arrow');
  assert.equal(data.edges[0].from, 'A');
  assert.equal(data.edges[0].to, 'B');
});

test('parseFlowchart parses dotted-no-arrow edge (A -.- B)', () => {
  const data = parseFlowchart('flowchart TD\n    A -.- B')!;
  assert.equal(data.edges.length, 1);
  assert.equal(data.edges[0].style, 'dotted-no-arrow');
  assert.equal(data.edges[0].from, 'A');
  assert.equal(data.edges[0].to, 'B');
});

// ── duration unit conversion (R-G03-04 / R-G15-03) ────────────────────────────

test('parseGantt converts week duration (Nw) into days', () => {
  const data = parseGantt('gantt\n    dateFormat YYYY-MM-DD\n    section S\n        T1 :t1, 2026-01-01, 2w\n')!;
  // 2 weeks = 14 days
  assert.equal(data.sections[0].tasks[0].duration, 14);
});

test('parseGantt converts hour duration (Nh) into ceil(N/24) days, min 1', () => {
  const d36 = parseGantt('gantt\n    dateFormat YYYY-MM-DD\n    section S\n        T1 :t1, 2026-01-01, 36h\n')!;
  assert.equal(d36.sections[0].tasks[0].duration, 2); // ceil(36/24)=2
  const d6 = parseGantt('gantt\n    dateFormat YYYY-MM-DD\n    section S\n        T1 :t1, 2026-01-01, 6h\n')!;
  assert.equal(d6.sections[0].tasks[0].duration, 1); // ceil(6/24)=1 (min 1)
});

test('parseGantt derives duration from an explicit end date (start, endDate)', () => {
  // start 2026-01-01, end 2026-01-05 → diffDays = 4
  const data = parseGantt('gantt\n    dateFormat YYYY-MM-DD\n    section S\n        T1 :t1, 2026-01-01, 2026-01-05\n')!;
  assert.equal(data.sections[0].tasks[0].duration, 4);
});

// ── after-dependency resolution (R-G11-04) ────────────────────────────────────

test('parseGantt resolves after <id> to the predecessor end date and keeps afterId', () => {
  // T1: 2026-01-01 + 3d → ends 2026-01-04. T2 :after t1 → starts 2026-01-04.
  const data = parseGantt('gantt\n    dateFormat YYYY-MM-DD\n    section S\n        T1 :t1, 2026-01-01, 3d\n        T2 :after t1, 2d\n')!;
  const t2 = data.sections[0].tasks[1];
  assert.equal(t2.startDate, '2026-01-04');
  assert.equal(t2.afterId, 't1');
});

test('parseGantt leaves afterId unset for tasks with an absolute start date', () => {
  const data = parseGantt('gantt\n    dateFormat YYYY-MM-DD\n    section S\n        T1 :t1, 2026-01-01, 3d\n')!;
  assert.equal(data.sections[0].tasks[0].afterId, undefined);
});

// ── date helpers (parseDate / fmt) ────────────────────────────────────────────

test('parseDate and fmt round-trip a date string', () => {
  assert.equal(fmt(parseDate('2026-03-09')), '2026-03-09');
});

test('fmt zero-pads month and day', () => {
  assert.equal(fmt(parseDate('2026-1-2')), '2026-01-02');
});

// ── flowchart block detection (R-F01-01) ──────────────────────────────────────

test('getFlowchartBlock locates the flowchart fence among markdown content', () => {
  const text = '# Title\n\n```mermaid\nflowchart TD\n  A-->B\n```\n';
  const blk = getFlowchartBlock(text)!;
  assert.ok(blk);
  // The slice must be exactly the fenced block.
  assert.match(text.slice(blk.start, blk.end), /^```mermaid[\s\S]*```$/);
  assert.match(text.slice(blk.start, blk.end), /flowchart TD/);
});

test('getFlowchartBlock returns null when no flowchart block exists', () => {
  const text = '# Title\n\n```mermaid\ngantt\n  title X\n```\n';
  assert.equal(getFlowchartBlock(text), null);
});

test('getFlowchartBlock skips a gantt block and finds a later flowchart block', () => {
  const text = '```mermaid\ngantt\n  title G\n```\n\n```mermaid\ngraph LR\n  A --> B\n```\n';
  const blk = getFlowchartBlock(text)!;
  assert.ok(blk);
  assert.match(text.slice(blk.start, blk.end), /graph LR/);
});

// ── A -- label --> B edge form ────────────────────────────────────────────────

test('parseFlowchart parses the "A -- label --> B" spaced-label form', () => {
  const data = parseFlowchart('flowchart TD\n    A -- yes --> B')!;
  assert.equal(data.edges.length, 1);
  assert.equal(data.edges[0].label, 'yes');
  assert.equal(data.edges[0].style, 'solid-arrow');
  assert.equal(data.edges[0].from, 'A');
  assert.equal(data.edges[0].to, 'B');
});

// ── subgraph / comment handling in parse (R-FP-03) ────────────────────────────

test('parseFlowchart ignores subgraph/end wrappers and comments while keeping inner edges', () => {
  const data = parseFlowchart('flowchart TD\n  %% a comment\n  subgraph G\n    A[開始] --> B\n  end')!;
  assert.equal(data.edges.length, 1);
  assert.equal(data.edges[0].from, 'A');
  assert.equal(data.edges[0].to, 'B');
  const a = data.nodes.find(n => n.id === 'A')!;
  assert.equal(a.label, '開始');
});

// ── parallel-edge indexing ────────────────────────────────────────────────────

test('parseFlowchart assigns distinct ids to parallel edges between the same nodes', () => {
  const data = parseFlowchart('flowchart TD\n    A --> B\n    A --> B')!;
  assert.equal(data.edges.length, 2);
  assert.equal(data.edges[0].id, 'A::B::0');
  assert.equal(data.edges[1].id, 'A::B::1');
});
