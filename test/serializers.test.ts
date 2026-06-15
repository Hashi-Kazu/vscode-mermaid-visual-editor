import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  setDirection, editNodeLabel, addNode, deleteNode,
  addEdge, editEdgeLabel, deleteEdge, changeEdgeStyle, changeNodeShape,
  applyToDocument as flowApply,
} from '../src/flowchartSerializer';
import { ganttToCode, applyToDocument as ganttApply } from '../src/ganttSerializer';
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

test('ganttApply preserves the mermaid fence on CRLF documents', () => {
  const doc = '```mermaid\r\ngantt\r\n    title X\r\n```\r\n';
  const out = ganttApply(doc, 'project.md', 'gantt\n    title Y');
  assert.match(out, /```mermaid/);
  assert.match(out, /title Y/);
});
