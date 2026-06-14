/** Apply targeted string-level operations to raw flowchart code. */

import { EdgeStyle, NodeShape } from './types';

// Matches any supported edge connector; -.-> must precede -.- to avoid partial match
const CONNECTOR_RE = /(-\.->|==>|---|-->|-\.-)/;

function styleToConnector(style: EdgeStyle): string {
  switch (style) {
    case 'dotted-arrow':    return '-.->';
    case 'thick-arrow':     return '==>';
    case 'solid-no-arrow':  return '---';
    case 'dotted-no-arrow': return '-.-';
    default:                return '-->';
  }
}

export function changeEdgeStyle(
  code: string,
  from: string,
  to: string,
  idx: number,
  style: EdgeStyle
): string {
  const lines = code.split('\n');
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!isEdgeLine(t)) continue;
    if (!lineConnects(t, from, to)) continue;
    if (count === idx) {
      lines[i] = lines[i].replace(CONNECTOR_RE, styleToConnector(style));
      break;
    }
    count++;
  }
  return lines.join('\n');
}

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SHAPE_WRAP: Record<NodeShape, [string, string]> = {
  rect:    ['[',  ']'],
  round:   ['(',  ')'],
  diamond: ['{',  '}'],
  stadium: ['([', '])'],
  circle:  ['((', '))'],
};

export function changeNodeShape(code: string, nodeId: string, shape: NodeShape): string {
  const [open, close] = SHAPE_WRAP[shape];
  const id = esc(nodeId);
  // Match the existing shape brackets and extract the label inside
  const re = new RegExp(
    `(\\b${id})(\\(\\[|\\(\\(|\\[|\\(|\\{)([^\\]\\)\\}]*)(\\]\\)|\\)\\)|\\]|\\)|\\})`,
    ''
  );
  const updated = code.replace(re, (_, nid, _open, label) => `${nid}${open}${label}${close}`);
  if (updated !== code) return updated;
  // Node had no shape brackets yet: append a definition
  return appendAfterHeader(code, `    ${nodeId}${open}${nodeId}${close}`);
}

export function setDirection(code: string, direction: string): string {
  return code.replace(
    /^(flowchart|graph)\s+(TD|LR|BT|RL|TB)/im,
    (_, kw) => `${kw} ${direction}`
  );
}

export function editNodeLabel(code: string, nodeId: string, newLabel: string): string {
  const id = esc(nodeId);
  // Replace first occurrence of nodeId followed by any shape bracket
  const re = new RegExp(
    `(\\b${id})(\\[(?:[^\\]]*)]|\\{[^}]*}|\\(\\[[^\\]]*]\\)|\\(\\([^)]*\\)\\)|\\([^)]*\\))`,
    ''
  );
  const updated = code.replace(re, (_, nid, shape) => {
    if (shape.startsWith('['))   return `${nid}[${newLabel}]`;
    if (shape.startsWith('{'))   return `${nid}{${newLabel}}`;
    if (shape.startsWith('(['))  return `${nid}([${newLabel}])`;
    if (shape.startsWith('(('))  return `${nid}((${newLabel}))`;
    if (shape.startsWith('('))   return `${nid}(${newLabel})`;
    return `${nid}[${newLabel}]`;
  });
  // If nodeId had no shape bracket, add a standalone definition
  if (updated === code) {
    return appendAfterHeader(code, `    ${nodeId}[${newLabel}]`);
  }
  return updated;
}

export function addNode(code: string): { code: string; nodeId: string } {
  const nodeId = genNodeId(code);
  const label = '新しいノード';
  const newCode = appendAfterHeader(code, `    ${nodeId}[${label}]`);
  return { code: newCode, nodeId };
}

export function deleteNode(code: string, nodeId: string): string {
  const id = esc(nodeId);
  const lines = code.split('\n');
  const result: string[] = [];

  for (const line of lines) {
    const t = line.trim();
    // Remove lines that are edges involving this node
    if (isEdgeLine(t) && lineReferencesNode(t, nodeId)) {
      continue;
    }
    // Remove standalone node definitions (but keep the header line)
    if (isStandaloneNodeDef(t, id)) {
      continue;
    }
    result.push(line);
  }
  return result.join('\n');
}

export function addEdge(code: string, from: string, to: string, label?: string): string {
  const arrow = label ? `-->|${label}|` : `-->`;
  return code.trimEnd() + `\n    ${from} ${arrow} ${to}\n`;
}

export function editEdgeLabel(
  code: string, from: string, to: string, idx: number, newLabel: string
): string {
  const lines = code.split('\n');
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!isEdgeLine(t)) continue;
    if (!lineConnects(t, from, to)) continue;
    if (count === idx) {
      if (newLabel === '') {
        // Remove label: strip pipe label for any connector, or inline text for -- label -->
        lines[i] = lines[i]
          .replace(/(-\.->|==>|---|-->|-\.-)\|[^|]*\|/, '$1')
          .replace(/\s*--\s+\S.*?-->/, ' -->');
      } else {
        // Set or update label using pipe syntax for all connector types
        if (CONNECTOR_RE.test(lines[i]) && lines[i].includes('|')) {
          lines[i] = lines[i].replace(/(-\.->|==>|---|-->|-\.-)\|[^|]*\|/, `$1|${newLabel}|`);
        } else {
          lines[i] = lines[i].replace(CONNECTOR_RE, `$1|${newLabel}|`);
        }
      }
      break;
    }
    count++;
  }
  return lines.join('\n');
}

export function deleteEdge(code: string, from: string, to: string, idx: number): string {
  const lines = code.split('\n');
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!isEdgeLine(t)) continue;
    if (!lineConnects(t, from, to)) continue;
    if (count === idx) {
      lines.splice(i, 1);
      break;
    }
    count++;
  }
  return lines.join('\n');
}

/** Replace the flowchart block in a markdown document with new code. */
export function applyToDocument(docText: string, fileName: string, newCode: string): string {
  if (fileName.endsWith('.mmd')) return newCode;
  const replaced = docText.replace(
    /(```mermaid[ \t]*\r?\n)([\s\S]*?)(```)/,
    (_, open, body, close) => {
      if (/^(flowchart|graph)\s+/im.test(body)) {
        return open + newCode + '\n' + close;
      }
      return _;
    }
  );
  return replaced !== docText ? replaced : newCode;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function appendAfterHeader(code: string, line: string): string {
  const lines = code.split('\n');
  const hIdx = lines.findIndex(l => /^(flowchart|graph)\s+/i.test(l.trim()));
  if (hIdx === -1) return code + '\n' + line;
  lines.splice(hIdx + 1, 0, line);
  return lines.join('\n');
}

function genNodeId(code: string): string {
  let n = 1;
  while (new RegExp(`\\bnode${n}\\b`).test(code)) n++;
  return `node${n}`;
}

function isEdgeLine(t: string): boolean {
  return /-->|---|-->>|-\.->|==>|-\.-/.test(t);
}

function lineReferencesNode(t: string, nodeId: string): boolean {
  // Check if the line contains the nodeId as a standalone token
  const escaped = esc(nodeId);
  return new RegExp(`(?:^|\\s|\\|)${escaped}(?:[\\[\\({]|\\s|$|-->|---|\\|)`).test(t);
}

function lineConnects(t: string, from: string, to: string): boolean {
  // Line must reference both from and to as connected nodes
  return lineReferencesNode(t, from) && lineReferencesNode(t, to);
}

function isStandaloneNodeDef(t: string, escapedId: string): boolean {
  // A standalone node def: just ID[...] or ID{...} or ID without arrows
  if (isEdgeLine(t)) return false;
  return new RegExp(`^${escapedId}(?:[\\[\\({]|$)`).test(t);
}
