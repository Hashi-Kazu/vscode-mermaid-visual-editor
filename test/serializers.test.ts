import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  setDirection, editNodeLabel, addNode, deleteNode,
  addEdge, editEdgeLabel, deleteEdge, changeEdgeStyle, changeNodeShape,
  applyToDocument as flowApply,
} from '../src/flowchartSerializer';
import { ganttToCode, applyToDocument as ganttApply } from '../src/ganttSerializer';
import { parseGantt } from '../src/ganttParser';
import { GanttData } from '../src/types';

const FC = 'flowchart TD\n    A[開始] --> B{条件}\n    B -->|はい| C[処理A]';

test('setDirection rewrites only the direction token', () => {
  assert.equal(setDirection(FC, 'LR').split('\n')[0], 'flowchart LR');
  // graph keyword must be preserved
  assert.equal(setDirection('graph TD\n  A-->B', 'RL').split('\n')[0], 'graph RL');
});

test('editNodeLabel updates label keeping the shape', () => {
  const out = editNodeLabel(FC, 'B', '新条件');
  assert.match(out, /B\{新条件\}/);
  assert.doesNotMatch(out, /B\{条件\}/);
});

test('editNodeLabel on a node without brackets appends a definition', () => {
  const out = editNodeLabel('flowchart TD\n    A --> B', 'A', 'ラベル');
  assert.match(out, /A\[ラベル\]/);
});

test('addNode generates a unique incrementing id', () => {
  const r1 = addNode(FC);
  assert.equal(r1.nodeId, 'node1');
  const r2 = addNode(r1.code);
  assert.equal(r2.nodeId, 'node2');
});

test('changeNodeShape converts brackets', () => {
  assert.match(changeNodeShape(FC, 'A', 'diamond'), /A\{開始\}/);
  assert.match(changeNodeShape(FC, 'A', 'round'), /A\(開始\)/);
  assert.match(changeNodeShape(FC, 'A', 'stadium'), /A\(\[開始\]\)/);
  assert.match(changeNodeShape(FC, 'A', 'circle'), /A\(\(開始\)\)/);
});

test('editNodeLabel extracts inline defs into a single standalone declaration (lazy separation)', () => {
  const code = 'flowchart TD\n    A[開始] --> B\n    A[開始] --> C';
  const out = editNodeLabel(code, 'A', '新開始');
  // インライン定義はすべて剥がされ、エッジは ID 参照のみになる
  assert.doesNotMatch(out, /A\[開始\]/);
  assert.match(out, /^\s*A --> B$/m);
  assert.match(out, /^\s*A --> C$/m);
  // 新ラベルの単独宣言がちょうど1つだけ存在する
  const declCount = out.split('\n').filter(l => l.trim() === 'A[新開始]').length;
  assert.equal(declCount, 1);
});

test('changeNodeShape separates the node and keeps the edge id-only', () => {
  const out = changeNodeShape('flowchart TD\n    A[開始] --> B', 'A', 'diamond');
  assert.match(out, /^\s*A\{開始\}$/m);   // 単独宣言（形状変更・ラベル保持）
  assert.match(out, /^\s*A --> B$/m);      // エッジは ID 参照のみ
  assert.doesNotMatch(out, /A\[開始\] -->/);
});

test('changeEdgeStyle swaps the connector for the indexed edge', () => {
  const out = changeEdgeStyle(FC, 'A', 'B', 0, 'dotted-arrow');
  assert.match(out, /A\[開始\] -\.-> B\{条件\}/);
});

test('changeEdgeStyle targets only the directional edge, not the reverse', () => {
  const code = 'flowchart TD\n    A --> B\n    B --> A';
  const out = changeEdgeStyle(code, 'A', 'B', 0, 'thick-arrow');
  // A --> B だけが太線になり、逆向き B --> A は変わらない
  assert.match(out, /^\s*A ==> B$/m);
  assert.match(out, /^\s*B --> A$/m);
});

test('editEdgeLabel does not bleed into the reverse-direction edge', () => {
  const code = 'flowchart TD\n    A --> B\n    B --> A';
  const out = editEdgeLabel(code, 'B', 'A', 0, 'ラベル');
  assert.match(out, /^\s*A --> B$/m);          // 無関係なまま
  assert.match(out, /^\s*B -->\|ラベル\| A$/m); // 対象のみ更新
});

test('deleteEdge removes only the directional edge among parallels', () => {
  const code = 'flowchart TD\n    A --> B\n    B --> A\n    A --> B';
  const out = deleteEdge(code, 'A', 'B', 1); // 2本目の A --> B を削除
  const abCount = out.split('\n').filter(l => /^\s*A --> B$/.test(l)).length;
  assert.equal(abCount, 1);
  assert.match(out, /^\s*B --> A$/m); // 逆向きは残る
});

test('addEdge appends an arrow line', () => {
  const out = addEdge('flowchart TD\n    A --> B', 'B', 'C');
  assert.match(out, /B --> C/);
});

test('addEdge honors the default edge style', () => {
  assert.match(addEdge('flowchart TD\n    A --> B', 'B', 'C', undefined, 'dotted-arrow'), /^\s*B -\.-> C$/m);
  assert.match(addEdge('flowchart TD\n    A --> B', 'B', 'C', undefined, 'thick-arrow'), /^\s*B ==> C$/m);
  assert.match(addEdge('flowchart TD\n    A --> B', 'B', 'C', undefined, 'solid-no-arrow'), /^\s*B --- C$/m);
  // 未指定は実線矢印
  assert.match(addEdge('flowchart TD\n    A --> B', 'B', 'C'), /^\s*B --> C$/m);
});

test('editEdgeLabel sets and removes a pipe label', () => {
  const set = editEdgeLabel('flowchart TD\n    A --> B', 'A', 'B', 0, 'yes');
  assert.match(set, /A -->\|yes\| B/);
  const cleared = editEdgeLabel(set, 'A', 'B', 0, '');
  assert.match(cleared, /A --> B/);
  assert.doesNotMatch(cleared, /\|yes\|/);
});

test('deleteEdge removes the indexed edge line', () => {
  const out = deleteEdge(FC, 'B', 'C', 0);
  assert.doesNotMatch(out, /B -->\|はい\| C/);
  assert.match(out, /A\[開始\] --> B/);
});

test('deleteNode removes node definition and connected edges', () => {
  const out = deleteNode(FC, 'B');
  assert.doesNotMatch(out, /\bB\b/);
});

test('flowApply preserves the mermaid fence on CRLF documents', () => {
  const doc = '# Title\r\n\r\n```mermaid\r\nflowchart TD\r\n    A --> B\r\n```\r\n';
  const out = flowApply(doc, 'project.md', 'flowchart LR\n    A --> B');
  assert.match(out, /```mermaid/);
  assert.match(out, /flowchart LR/);
  assert.match(out, /```\r?\n?$/);
});

test('ganttToCode serializes status, id, afterId and duration', () => {
  const data: GanttData = {
    title: 'P', dateFormat: 'YYYY-MM-DD', sections: [
      { name: 'S', tasks: [
        { id: 't1', label: 'A', status: 'done', startDate: '2026-01-01', duration: 3 },
        { id: 't2', label: 'B', status: '', startDate: '2026-01-04', duration: 2, afterId: 't1' },
      ] },
    ],
  };
  const code = ganttToCode(data);
  assert.match(code, /A :done, t1, 2026-01-01, 3d/);
  assert.match(code, /B :t2, after t1, 2d/);
});

// ── crit serialization ────────────────────────────────────────────────────────

test('ganttToCode serializes crit flag alone', () => {
  const data: GanttData = {
    title: 'P', dateFormat: 'YYYY-MM-DD', sections: [
      { name: 'S', tasks: [
        { id: 't1', label: 'A', status: '', crit: true, startDate: '2026-01-01', duration: 3 },
      ] },
    ],
  };
  const code = ganttToCode(data);
  assert.match(code, /A :crit, t1, 2026-01-01, 3d/);
});

test('ganttToCode serializes crit combined with done', () => {
  const data: GanttData = {
    title: 'P', dateFormat: 'YYYY-MM-DD', sections: [
      { name: 'S', tasks: [
        { id: 't1', label: 'A', status: 'done', crit: true, startDate: '2026-01-01', duration: 3 },
      ] },
    ],
  };
  const code = ganttToCode(data);
  // crit must appear before done per Mermaid convention
  assert.match(code, /A :crit, done, t1, 2026-01-01, 3d/);
});

test('ganttToCode does not emit crit when flag is absent or false', () => {
  const data: GanttData = {
    title: 'P', dateFormat: 'YYYY-MM-DD', sections: [
      { name: 'S', tasks: [
        { id: '', label: 'A', status: 'active', startDate: '2026-01-01', duration: 3 },
      ] },
    ],
  };
  const code = ganttToCode(data);
  assert.doesNotMatch(code, /crit/);
});

// ── crit round-trip ───────────────────────────────────────────────────────────

test('crit round-trip: standalone crit survives serialize → parse', () => {
  const data: GanttData = {
    title: 'P', dateFormat: 'YYYY-MM-DD', sections: [
      { name: 'S', tasks: [
        { id: 't1', label: 'A', status: '', crit: true, startDate: '2026-01-01', duration: 3 },
      ] },
    ],
  };
  const round = parseGantt(ganttToCode(data))!;
  const task = round.sections[0].tasks[0];
  assert.equal(task.crit, true);
  assert.equal(task.status, '');
});

test('crit round-trip: crit + done combination survives serialize → parse', () => {
  const data: GanttData = {
    title: 'P', dateFormat: 'YYYY-MM-DD', sections: [
      { name: 'S', tasks: [
        { id: 't1', label: 'A', status: 'done', crit: true, startDate: '2026-01-01', duration: 3 },
      ] },
    ],
  };
  const round = parseGantt(ganttToCode(data))!;
  const task = round.sections[0].tasks[0];
  assert.equal(task.crit, true);
  assert.equal(task.status, 'done');
});

test('crit round-trip: removing crit flag reflects in serialized code', () => {
  // Start with crit=true, then toggle it off
  const data: GanttData = {
    title: 'P', dateFormat: 'YYYY-MM-DD', sections: [
      { name: 'S', tasks: [
        { id: 't1', label: 'A', status: '', crit: true, startDate: '2026-01-01', duration: 3 },
      ] },
    ],
  };
  // Toggle off
  delete data.sections[0].tasks[0].crit;
  const code = ganttToCode(data);
  assert.doesNotMatch(code, /crit/);
  const round = parseGantt(code)!;
  assert.equal(round.sections[0].tasks[0].crit, undefined);
});

// ── Section name round-trip ───────────────────────────────────────────────────

test('section name change round-trip: renamed section survives serialize → parse', () => {
  const data: GanttData = {
    title: 'P', dateFormat: 'YYYY-MM-DD', sections: [
      { name: '旧名称', tasks: [
        { id: '', label: 'T1', status: '', startDate: '2026-01-01', duration: 3 },
      ] },
    ],
  };
  // Simulate rename
  data.sections[0].name = '新しい名称';
  const code = ganttToCode(data);
  assert.match(code, /section 新しい名称/);
  const round = parseGantt(code)!;
  assert.equal(round.sections[0].name, '新しい名称');
  assert.equal(round.sections[0].tasks[0].label, 'T1');
});

test('section name change: Japanese multi-byte name round-trip', () => {
  const data: GanttData = {
    title: 'P', dateFormat: 'YYYY-MM-DD', sections: [
      { name: 'フェーズ 1　設計', tasks: [
        { id: '', label: 'T1', status: '', startDate: '2026-01-01', duration: 5 },
      ] },
    ],
  };
  const code = ganttToCode(data);
  const round = parseGantt(code)!;
  assert.equal(round.sections[0].name, 'フェーズ 1　設計');
});

test('ganttToCode preserves a non-leading unnamed section across round-trip', () => {
  const data: GanttData = {
    title: 'P', dateFormat: 'YYYY-MM-DD', sections: [
      { name: 'S1', tasks: [
        { id: '', label: 'A', status: '', startDate: '2026-01-01', duration: 2 },
      ] },
      { name: '', tasks: [
        { id: '', label: 'B', status: '', startDate: '2026-01-03', duration: 2 },
      ] },
    ],
  };
  const round = parseGantt(ganttToCode(data))!;
  // Without the explicit boundary, B would merge into S1, collapsing to 1 section.
  assert.equal(round.sections.length, 2);
  assert.equal(round.sections[0].name, 'S1');
  assert.equal(round.sections[1].name, '');
  assert.equal(round.sections[1].tasks[0].label, 'B');
});

test('ganttToCode keeps leading pre-section tasks without a boundary marker', () => {
  const data: GanttData = {
    title: 'P', dateFormat: 'YYYY-MM-DD', sections: [
      { name: '', tasks: [
        { id: '', label: 'A', status: '', startDate: '2026-01-01', duration: 2 },
      ] },
      { name: 'S1', tasks: [
        { id: '', label: 'B', status: '', startDate: '2026-01-03', duration: 2 },
      ] },
    ],
  };
  const code = ganttToCode(data);
  // The leading unnamed section emits no `section` line.
  assert.doesNotMatch(code.split('section S1')[0], /section/);
  const round = parseGantt(code)!;
  assert.equal(round.sections.length, 2);
  assert.equal(round.sections[0].name, '');
  assert.equal(round.sections[0].tasks[0].label, 'A');
});

test('parseGantt preserves a named empty section (no tasks)', () => {
  const code = 'gantt\n    dateFormat YYYY-MM-DD\n\n    section A\n        T1 :2026-01-01, 2d\n\n    section Empty\n';
  const data = parseGantt(code)!;
  assert.equal(data.sections.length, 2);
  assert.equal(data.sections[1].name, 'Empty');
  assert.equal(data.sections[1].tasks.length, 0);
});

test('parseGantt preserves an explicit unnamed empty section', () => {
  // `section ` (unnamed) with no following tasks must survive — it is an
  // explicit user-created section, not the implicit leading placeholder.
  const code = 'gantt\n    dateFormat YYYY-MM-DD\n\n    section A\n        T1 :2026-01-01, 2d\n\n    section \n';
  const data = parseGantt(code)!;
  assert.equal(data.sections.length, 2);
  assert.equal(data.sections[1].name, '');
  assert.equal(data.sections[1].tasks.length, 0);
});

test('parseGantt drops only the implicit leading placeholder when empty', () => {
  // No pre-section tasks → the leading placeholder is removed.
  const code = 'gantt\n    dateFormat YYYY-MM-DD\n\n    section A\n        T1 :2026-01-01, 2d\n';
  const data = parseGantt(code)!;
  assert.equal(data.sections.length, 1);
  assert.equal(data.sections[0].name, 'A');
});

test('empty sections survive a full serialize -> parse round-trip', () => {
  const data: GanttData = {
    title: 'P', dateFormat: 'YYYY-MM-DD', sections: [
      { name: 'A', tasks: [{ id: '', label: 'T1', status: '', startDate: '2026-01-01', duration: 2 }] },
      { name: 'Named empty', tasks: [] },
      { name: '', tasks: [] },
    ],
  };
  const round = parseGantt(ganttToCode(data))!;
  assert.equal(round.sections.length, 3);
  assert.equal(round.sections[1].name, 'Named empty');
  assert.equal(round.sections[1].tasks.length, 0);
  assert.equal(round.sections[2].name, '');
  assert.equal(round.sections[2].tasks.length, 0);
});

test('ganttApply preserves the mermaid fence on CRLF documents', () => {
  const doc = '```mermaid\r\ngantt\r\n    title X\r\n```\r\n';
  const out = ganttApply(doc, 'project.md', 'gantt\n    title Y');
  assert.match(out, /```mermaid/);
  assert.match(out, /title Y/);
});

// ── milestone serialization ───────────────────────────────────────────────────

test('ganttToCode serializes milestone status', () => {
  const data: GanttData = {
    title: 'P', dateFormat: 'YYYY-MM-DD', sections: [
      { name: 'S', tasks: [
        { id: 'm1', label: 'M1', status: 'milestone', startDate: '2026-03-01', duration: 0 },
      ] },
    ],
  };
  const code = ganttToCode(data);
  assert.match(code, /M1 :milestone, m1, 2026-03-01, 0d/);
});

test('ganttToCode serializes crit + milestone (crit first)', () => {
  const data: GanttData = {
    title: 'P', dateFormat: 'YYYY-MM-DD', sections: [
      { name: 'S', tasks: [
        { id: 'm1', label: 'M1', status: 'milestone', crit: true, startDate: '2026-03-01', duration: 0 },
      ] },
    ],
  };
  const code = ganttToCode(data);
  assert.match(code, /M1 :crit, milestone, m1, 2026-03-01, 0d/);
});

// ── active status serialization ───────────────────────────────────────────────

test('ganttToCode serializes active status', () => {
  const data: GanttData = {
    title: 'P', dateFormat: 'YYYY-MM-DD', sections: [
      { name: 'S', tasks: [
        { id: 'a1', label: 'A', status: 'active', startDate: '2026-02-01', duration: 5 },
      ] },
    ],
  };
  const code = ganttToCode(data);
  assert.match(code, /A :active, a1, 2026-02-01, 5d/);
});

test('ganttToCode serializes crit + active (crit first)', () => {
  const data: GanttData = {
    title: 'P', dateFormat: 'YYYY-MM-DD', sections: [
      { name: 'S', tasks: [
        { id: 'a1', label: 'A', status: 'active', crit: true, startDate: '2026-02-01', duration: 3 },
      ] },
    ],
  };
  const code = ganttToCode(data);
  assert.match(code, /A :crit, active, a1, 2026-02-01, 3d/);
});

// ── axisFormat / title serialization ─────────────────────────────────────────

test('ganttToCode emits axisFormat line when set', () => {
  const data: GanttData = {
    title: 'P', dateFormat: 'YYYY-MM-DD', axisFormat: '%m/%d', sections: [
      { name: 'S', tasks: [] },
    ],
  };
  const code = ganttToCode(data);
  assert.match(code, /axisFormat %m\/%d/);
});

test('ganttToCode omits axisFormat line when not set', () => {
  const data: GanttData = {
    title: 'P', dateFormat: 'YYYY-MM-DD', sections: [
      { name: 'S', tasks: [] },
    ],
  };
  const code = ganttToCode(data);
  assert.doesNotMatch(code, /axisFormat/);
});

test('ganttToCode omits axisFormat line when empty string', () => {
  const data: GanttData = {
    title: 'P', dateFormat: 'YYYY-MM-DD', axisFormat: '', sections: [
      { name: 'S', tasks: [] },
    ],
  };
  const code = ganttToCode(data);
  assert.doesNotMatch(code, /axisFormat/);
});

test('ganttToCode emits title line when set', () => {
  const data: GanttData = {
    title: 'test', dateFormat: 'YYYY-MM-DD', sections: [
      { name: 'S', tasks: [] },
    ],
  };
  const code = ganttToCode(data);
  assert.match(code, /title test/);
});

test('ganttToCode omits title line when empty string', () => {
  const data: GanttData = {
    title: '', dateFormat: 'YYYY-MM-DD', sections: [
      { name: 'S', tasks: [] },
    ],
  };
  const code = ganttToCode(data);
  assert.doesNotMatch(code, /title /);
});

// ── milestone round-trip ──────────────────────────────────────────────────────

test('milestone round-trip: status milestone survives serialize → parse', () => {
  const data: GanttData = {
    title: 'P', dateFormat: 'YYYY-MM-DD', sections: [
      { name: 'S', tasks: [
        { id: 'm1', label: 'M1', status: 'milestone', startDate: '2026-03-01', duration: 0 },
      ] },
    ],
  };
  const round = parseGantt(ganttToCode(data))!;
  const task = round.sections[0].tasks[0];
  assert.equal(task.status, 'milestone');
  assert.equal(task.crit, undefined);
  assert.equal(task.id, 'm1');
});

test('milestone round-trip: crit + milestone survives serialize → parse', () => {
  const data: GanttData = {
    title: 'P', dateFormat: 'YYYY-MM-DD', sections: [
      { name: 'S', tasks: [
        { id: 'm1', label: 'M1', status: 'milestone', crit: true, startDate: '2026-03-01', duration: 0 },
      ] },
    ],
  };
  const round = parseGantt(ganttToCode(data))!;
  const task = round.sections[0].tasks[0];
  assert.equal(task.status, 'milestone');
  assert.equal(task.crit, true);
});

// ── active + crit round-trip ──────────────────────────────────────────────────

test('active+crit round-trip: combination survives serialize → parse', () => {
  const data: GanttData = {
    title: 'P', dateFormat: 'YYYY-MM-DD', sections: [
      { name: 'S', tasks: [
        { id: 'a1', label: 'A', status: 'active', crit: true, startDate: '2026-02-01', duration: 3 },
      ] },
    ],
  };
  const round = parseGantt(ganttToCode(data))!;
  const task = round.sections[0].tasks[0];
  assert.equal(task.status, 'active');
  assert.equal(task.crit, true);
});

// ── multiple mermaid blocks: flowApply / ganttApply target only correct block ─

test('flowApply updates only the first flowchart block in a multi-block document', () => {
  const doc = '# Doc\n\n```mermaid\nflowchart TD\n    A --> B\n```\n\nText\n\n```mermaid\ngantt\n    title G\n    dateFormat YYYY-MM-DD\n```\n';
  const { applyToDocument: flowApply } = require('../src/flowchartSerializer');
  const out = flowApply(doc, 'project.md', 'flowchart LR\n    X --> Y');
  assert.match(out, /flowchart LR/);
  assert.match(out, /X --> Y/);
  // The gantt block must remain intact
  assert.match(out, /title G/);
});

test('ganttApply updates only the gantt mermaid block and leaves other content', () => {
  const doc = '# Doc\n\n```mermaid\ngantt\n    title Old\n    dateFormat YYYY-MM-DD\n```\n\nSome text after.\n';
  const out = ganttApply(doc, 'project.md', 'gantt\n    title New\n    dateFormat YYYY-MM-DD');
  assert.match(out, /title New/);
  assert.doesNotMatch(out, /title Old/);
  assert.match(out, /Some text after\./);
});

test('multiple blocks: ganttApply replaces only a later gantt block', () => {
  const flowBlock = '```mermaid\nflowchart TD\n    A --> B\n```';
  const doc = `# Doc\n\n${flowBlock}\n\nKeep this text.\n\n\`\`\`mermaid\ngantt\n    title Old\n    dateFormat YYYY-MM-DD\n\`\`\`\n`;
  const out = ganttApply(doc, 'project.md', 'gantt\n    title New\n    dateFormat YYYY-MM-DD');
  assert.match(out, /title New/);
  assert.ok(out.includes(flowBlock));
  assert.match(out, /Keep this text\./);
});

test('multiple blocks: flowApply replaces only a later flowchart block', () => {
  const ganttBlock = '```mermaid\ngantt\n    title G\n    dateFormat YYYY-MM-DD\n```';
  const doc = `# Doc\n\n${ganttBlock}\n\nKeep this text.\n\n\`\`\`mermaid\nflowchart TD\n    A --> B\n\`\`\`\n`;
  const out = flowApply(doc, 'project.md', 'flowchart LR\n    X --> Y');
  assert.match(out, /flowchart LR/);
  assert.ok(out.includes(ganttBlock));
  assert.match(out, /Keep this text\./);
});

test('.mmd documents keep the full-replacement behavior', () => {
  assert.equal(ganttApply('old content', 'project.mmd', 'gantt\n    title New'), 'gantt\n    title New');
  assert.equal(flowApply('old content', 'project.mmd', 'flowchart TD\n    A --> B'), 'flowchart TD\n    A --> B');
});

test('markdown without a mermaid fence keeps the full-replacement behavior', () => {
  assert.equal(ganttApply('gantt\n    title Old', 'project.md', 'gantt\n    title New'), 'gantt\n    title New');
  assert.equal(flowApply('flowchart TD\n    A --> B', 'project.md', 'flowchart LR\n    A --> B'), 'flowchart LR\n    A --> B');
});

test('markdown with fences but no matching diagram block remains unchanged', () => {
  const flowOnly = '# Doc\n\n```mermaid\nflowchart TD\n    A --> B\n```\n';
  const ganttOnly = '# Doc\n\n```mermaid\ngantt\n    title G\n```\n';
  assert.equal(ganttApply(flowOnly, 'project.md', 'gantt\n    title New'), flowOnly);
  assert.equal(flowApply(ganttOnly, 'project.md', 'flowchart LR\n    X --> Y'), ganttOnly);
});

// ── lazy-separation: subgraph / comment preservation (R-FP-02 / R-FP-03) ───────

test('editNodeLabel preserves subgraph/end wrappers and comments while separating the node', () => {
  const code = 'flowchart TD\n  %% a comment\n  subgraph G\n    A[古い] --> B\n  end';
  const out = editNodeLabel(code, 'A', '新しい');
  // The comment and subgraph structure must survive untouched.
  assert.match(out, /^\s*%% a comment$/m);
  assert.match(out, /^\s*subgraph G$/m);
  assert.match(out, /^\s*end$/m);
  // The edge is reduced to an id-only reference; A is declared exactly once.
  assert.match(out, /^\s*A --> B$/m);
  const declCount = out.split('\n').filter(l => l.trim() === 'A[新しい]').length;
  assert.equal(declCount, 1);
  assert.doesNotMatch(out, /A\[古い\]/);
});

test('changeNodeShape preserves comments and only rewrites the target node', () => {
  const code = 'flowchart TD\n  %% keep me\n  A[開始] --> B\n  B --> C';
  const out = changeNodeShape(code, 'A', 'stadium');
  assert.match(out, /^\s*%% keep me$/m);
  assert.match(out, /^\s*A\(\[開始\]\)$/m);   // separated stadium declaration
  assert.match(out, /^\s*A --> B$/m);          // edge id-only
  assert.match(out, /^\s*B --> C$/m);          // unrelated edge untouched
});

// ── addEdge keeps id-only form (R-FP-01) ──────────────────────────────────────

test('addEdge does not inline node bracket definitions (id reference only)', () => {
  const out = addEdge('flowchart TD\n    A[開始] --> B[条件]', 'A', 'B');
  // The appended line references ids only, with no bracket re-definition.
  assert.match(out, /^\s*A --> B$/m);
  assert.doesNotMatch(out, /A\[開始\] --> B\[条件\]\s*$\n\s*A\[/m);
});

// ── deleteNode robustness ─────────────────────────────────────────────────────

test('deleteNode removes the node and its edges but leaves unrelated nodes/edges', () => {
  const out = deleteNode('flowchart TD\n    A --> B\n    C --> D', 'A');
  assert.doesNotMatch(out, /^\s*A\b/m);
  assert.doesNotMatch(out, /--> A\b/m);
  assert.match(out, /^\s*C --> D$/m);   // unrelated edge survives
});

test('deleteNode removes only edges touching the target among parallels', () => {
  const out = deleteNode('flowchart TD\n    A --> B\n    B --> C\n    A --> C', 'A');
  // Edges with A on either side are gone; B --> C remains.
  assert.doesNotMatch(out, /A/);
  assert.match(out, /^\s*B --> C$/m);
});

// ── setDirection keyword preservation (R-F05-02) ──────────────────────────────

test('setDirection preserves the graph keyword and only swaps the direction token', () => {
  const out = setDirection('graph TD\n    A --> B', 'BT');
  assert.equal(out.split('\n')[0], 'graph BT');
  assert.match(out, /A --> B/);
});

// ── editEdgeLabel on parallel edges targets the indexed one ────────────────────

test('editEdgeLabel updates only the indexed edge among parallels', () => {
  const code = 'flowchart TD\n    A --> B\n    A --> B';
  const out = editEdgeLabel(code, 'A', 'B', 1, 'second');
  const lines = out.split('\n').filter(l => /A (-->|-->\|)/.test(l.trim()));
  // Exactly one of the two parallel A→B edges carries the new label.
  const labeled = lines.filter(l => /\|second\|/.test(l));
  assert.equal(labeled.length, 1);
});
