import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectConflict, normalizeText } from '../src/conflictDetection';

test('no base recorded yet → never a conflict (allow first write)', () => {
  assert.equal(detectConflict(null, 'anything', 'outgoing'), false);
});

test('current equals base → no conflict (safe to overwrite)', () => {
  const base = '```mermaid\ngantt\n  title A\n```\n';
  assert.equal(detectConflict(base, base, '```mermaid\ngantt\n  title B\n```\n'), false);
});

test('current differs from base → conflict (concurrent external edit)', () => {
  const base = '```mermaid\nflowchart TD\n  A --> B\n```\n';
  const current = '```mermaid\nflowchart TD\n  A --> B\n  B --> C\n```\n';
  const outgoing = '```mermaid\nflowchart TD\n  A --> D\n```\n';
  assert.equal(detectConflict(base, current, outgoing), true);
});

test('current already equals our outgoing → echo, not a conflict', () => {
  // Our own previous write landed on disk; the live text matches what we are
  // about to write. This must not be flagged as someone else changing it.
  const base = '```mermaid\nflowchart TD\n  A --> B\n```\n';
  const outgoing = '```mermaid\nflowchart TD\n  A --> C\n```\n';
  assert.equal(detectConflict(base, outgoing, outgoing), false);
});

test('CRLF vs LF difference alone is not a conflict', () => {
  const base = '# Doc\n```mermaid\ngantt\n```\n';
  const currentCRLF = '# Doc\r\n```mermaid\r\ngantt\r\n```\r\n';
  assert.equal(detectConflict(base, currentCRLF, '# Doc\n```mermaid\ngantt\n  title X\n```\n'), false);
});

test('CRLF base vs LF current with same content is not a conflict', () => {
  const base = '# Doc\r\n```mermaid\r\ngantt\r\n```\r\n';
  const current = '# Doc\n```mermaid\ngantt\n```\n';
  assert.equal(detectConflict(base, current, '# Doc\n```mermaid\ngantt\n  title Y\n```\n'), false);
});

test('conflict detection ignores newline style when comparing outgoing echo', () => {
  const base = '```mermaid\nflowchart TD\n  A --> B\n```\n';
  const outgoingCRLF = '```mermaid\r\nflowchart TD\r\n  A --> C\r\n```\r\n';
  const currentLF = '```mermaid\nflowchart TD\n  A --> C\n```\n';
  assert.equal(detectConflict(base, currentLF, outgoingCRLF), false);
});

test('normalizeText converts CRLF and lone CR to LF', () => {
  assert.equal(normalizeText('a\r\nb\rc\nd'), 'a\nb\nc\nd');
});

test('isOperating window: external edit during operation is detected at write time', () => {
  // Simulates the gap fix: base is the snapshot the view was built from; while
  // isOperating suppressed the sync, the live document received an external
  // edit. The pre-write check sees current != base and != outgoing → conflict.
  const base = '```mermaid\nflowchart TD\n  A --> B\n```\n';
  const externalLive = '```mermaid\nflowchart TD\n  A --> B\n  B --> C\n```\n';
  const myOutgoing = '```mermaid\nflowchart TD\n  A --> Bedited\n```\n';
  assert.equal(detectConflict(base, externalLive, myOutgoing), true);
});
