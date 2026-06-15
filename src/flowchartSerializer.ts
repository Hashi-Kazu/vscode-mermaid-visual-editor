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

// ── ノード記述の「遅延分離」ポリシー ────────────────────────────────────────
// エッジは ID 参照のみ、各ノードのラベル／形状は単独の宣言行に1つだけ持たせる。
// ノードを編集したときだけ、その対象ノードをエッジ内インライン定義から剥がして
// 単独宣言へ集約する（手付かずの既存行・サブグラフ・コメントは保持する）。

// ノードIDの直後に来るシェイプ囲み（複合形を先に並べて部分一致を防ぐ）
const SHAPE_BRACKETS =
  '(\\(\\[[^\\]]*\\]\\)|\\(\\([^)]*\\)\\)|\\[[^\\]]*\\]|\\{[^}]*\\}|\\([^)]*\\))';

function parseWrap(wrap: string): { label: string; shape: NodeShape } {
  if (wrap.startsWith('([')) return { label: wrap.slice(2, -2), shape: 'stadium' };
  if (wrap.startsWith('((')) return { label: wrap.slice(2, -2), shape: 'circle' };
  if (wrap.startsWith('['))  return { label: wrap.slice(1, -1), shape: 'rect' };
  if (wrap.startsWith('{'))  return { label: wrap.slice(1, -1), shape: 'diamond' };
  if (wrap.startsWith('('))  return { label: wrap.slice(1, -1), shape: 'round' };
  return { label: wrap, shape: 'rect' };
}

/** コード中の最初の定義からノードの現在のラベル・形状を取得する（パーサと同じ優先順位）。 */
function getNodeDef(code: string, nodeId: string): { label: string; shape: NodeShape } {
  const id = esc(nodeId);
  const re = new RegExp(`(?:^|[^A-Za-z0-9_-])${id}${SHAPE_BRACKETS}`, 'm');
  const m = code.match(re);
  if (m) return parseWrap(m[1]);
  return { label: nodeId, shape: 'rect' };
}

/** エッジ行に含まれる nodeId のインライン定義（囲み）を剥がして ID 参照のみにする。 */
function stripInlineNodeDefs(code: string, nodeId: string): string {
  const id = esc(nodeId);
  const re = new RegExp(`(^|[^A-Za-z0-9_-])${id}${SHAPE_BRACKETS}`, 'g');
  return code.split('\n').map(line => {
    if (!isEdgeLine(line.trim())) return line;
    return line.replace(re, (_full, pre) => `${pre}${nodeId}`);
  }).join('\n');
}

/** nodeId の単独宣言行を label+shape で更新する。無ければヘッダ直後に追加する。 */
function upsertNodeDecl(code: string, nodeId: string, label: string, shape: NodeShape): string {
  const [open, close] = SHAPE_WRAP[shape];
  const decl = `${nodeId}${open}${label}${close}`;
  const id = esc(nodeId);
  const declRe = new RegExp(`^${id}(?:${SHAPE_BRACKETS})?$`);
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (declRe.test(lines[i].trim())) {
      const indent = (lines[i].match(/^\s*/) || [''])[0] || '    ';
      lines[i] = indent + decl;
      return lines.join('\n');
    }
  }
  return appendAfterHeader(lines.join('\n'), `    ${decl}`);
}

export function changeNodeShape(code: string, nodeId: string, shape: NodeShape): string {
  // 遅延分離: 現在のラベルを保ったまま、対象ノードを単独宣言へ集約して形状を変更する
  const { label } = getNodeDef(code, nodeId);
  const stripped = stripInlineNodeDefs(code, nodeId);
  return upsertNodeDecl(stripped, nodeId, label, shape);
}

export function setDirection(code: string, direction: string): string {
  return code.replace(
    /^(flowchart|graph)\s+(TD|LR|BT|RL|TB)/im,
    (_, kw) => `${kw} ${direction}`
  );
}

export function editNodeLabel(code: string, nodeId: string, newLabel: string): string {
  // 遅延分離: 現在の形状を保ったまま、対象ノードを単独宣言へ集約してラベルを変更する
  const { shape } = getNodeDef(code, nodeId);
  const stripped = stripInlineNodeDefs(code, nodeId);
  return upsertNodeDecl(stripped, nodeId, newLabel, shape);
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

// 遅延分離ポリシー: エッジは常に ID 参照のみで追加する（ノード定義は単独宣言行が持つ）。
// style は新規エッジの既定線種（ビューア側で保持する一時設定。未指定は実線矢印）。
export function addEdge(
  code: string, from: string, to: string, label?: string, style?: EdgeStyle
): string {
  const connector = styleToConnector(style ?? 'solid-arrow');
  const arrow = label ? `${connector}|${label}|` : connector;
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

function leadingNodeId(token: string): string | null {
  const m = token.trim().match(/^([A-Za-z0-9_][A-Za-z0-9_-]*)/);
  return m ? m[1] : null;
}

/** エッジ行の始点・終点ノードIDを実際にパースして返す（ラベルは除去）。 */
function edgeEndpoints(t: string): { from: string; to: string } | null {
  if (!isEdgeLine(t)) return null;
  // ラベルを除去して端点解決を単純化する
  const s = t
    .replace(/(-\.->|==>|---|-->|-\.-)\|[^|]*\|/, '$1') // パイプラベル A -->|x| B
    .replace(/\s--\s+\S.*?-->/, ' -->');                // インラインラベル A -- x --> B
  // 連結子の長いもの／曖昧なものを先に並べて部分一致を防ぐ
  const m = s.match(/^(.+?)\s*(-\.->|-\.-|==>|---|-->)\s*(.+)$/);
  if (!m) return null;
  const from = leadingNodeId(m[1]);
  const to = leadingNodeId(m[3]);
  if (!from || !to) return null;
  return { from, to };
}

function lineConnects(t: string, from: string, to: string): boolean {
  // 始点→終点の向きまで一致するエッジ行のみを対象にする
  // （非方向の一致だと A-->B と B-->A を取り違え、別のエッジを変更してしまう）
  const ep = edgeEndpoints(t);
  return !!ep && ep.from === from && ep.to === to;
}

function isStandaloneNodeDef(t: string, escapedId: string): boolean {
  // A standalone node def: just ID[...] or ID{...} or ID without arrows
  if (isEdgeLine(t)) return false;
  return new RegExp(`^${escapedId}(?:[\\[\\({]|$)`).test(t);
}
