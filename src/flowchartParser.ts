import { FlowchartData, FlowchartNode, FlowchartEdge, EdgeStyle, NodeShape } from './types';

export function parseFlowchart(text: string): FlowchartData | null {
  const block = getFlowchartBlock(text);
  if (block) {
    const match = text.slice(block.start, block.end).match(/```mermaid[ \t]*\r?\n([\s\S]*?)```/);
    return parseCode(match![1].trim());
  }
  if (/```mermaid[ \t]*\r?\n/.test(text)) return null;
  return parseCode(text.trim());
}

function parseCode(code: string): FlowchartData | null {
  const lines = code.split('\n');
  let keyword: 'flowchart' | 'graph' = 'flowchart';
  let direction: FlowchartData['direction'] = 'TD';
  let foundHeader = false;

  for (const line of lines) {
    const t = line.trim();
    const m = t.match(/^(flowchart|graph)\s+(TD|LR|BT|RL|TB)/i);
    if (m) {
      keyword = m[1].toLowerCase() as 'flowchart' | 'graph';
      const rawDir = m[2].toUpperCase();
      direction = (rawDir === 'TB' ? 'TD' : rawDir) as FlowchartData['direction'];
      foundHeader = true;
      break;
    }
  }
  if (!foundHeader) return null;

  const nodeMap = new Map<string, { label: string; shape: NodeShape }>(); // id -> {label, shape}
  const edges: FlowchartEdge[] = [];
  const edgeCounts = new Map<string, number>();
  let pastHeader = false;
  let subgraphDepth = 0;

  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('%%') || t.startsWith('//')) continue;
    if (/^(flowchart|graph)\s+/i.test(t)) { pastHeader = true; continue; }
    if (!pastHeader) continue;
    if (/^subgraph(\s|$)/i.test(t)) { subgraphDepth++; continue; }
    if (t === 'end' && subgraphDepth > 0) { subgraphDepth--; continue; }

    parseLine(t, nodeMap, edges, edgeCounts);
  }

  const nodes: FlowchartNode[] = [...nodeMap.entries()].map(([id, v]) => ({ id, label: v.label, shape: v.shape }));
  return { direction, keyword, nodes, edges };
}

function connectorToStyle(connector: string): EdgeStyle {
  if (connector === '-.->') return 'dotted-arrow';
  if (connector === '==>') return 'thick-arrow';
  if (connector === '---') return 'solid-no-arrow';
  if (connector === '-.-') return 'dotted-no-arrow';
  return 'solid-arrow';
}

function parseLine(
  line: string,
  nodeMap: Map<string, { label: string; shape: NodeShape }>,
  edges: FlowchartEdge[],
  edgeCounts: Map<string, number>
): void {
  // Pattern 1: A connector|label| B (all connector types with pipe label)
  // -.-> before -.- to avoid premature partial match
  let m = line.match(/^(.+?)\s*(-.->|-\.-|==>|---|-->)\|([^|]*)\|\s*(.+)$/);
  if (m) { addEdge(m[1], m[4], m[3].trim() || undefined, m[2], nodeMap, edges, edgeCounts); return; }

  // Pattern 2: A -- label --> B
  m = line.match(/^(.+?)\s*--\s+(.+?)\s+-->\s*(.+)$/);
  if (m) { addEdge(m[1], m[3], m[2].trim() || undefined, '-->', nodeMap, edges, edgeCounts); return; }

  // Pattern 3: simple arrows (no label)
  m = line.match(/^(.+?)\s*(-->|---|-->>|-\.->|==>|~~~|-\.-)\s*(.+)$/);
  if (m) { addEdge(m[1], m[3], undefined, m[2], nodeMap, edges, edgeCounts); return; }

  // Standalone node definition
  const node = extractNode(line.trim());
  if (node && !nodeMap.has(node.id)) nodeMap.set(node.id, { label: node.label, shape: node.shape });
}

function addEdge(
  fromToken: string,
  toToken: string,
  label: string | undefined,
  connector: string,
  nodeMap: Map<string, { label: string; shape: NodeShape }>,
  edges: FlowchartEdge[],
  edgeCounts: Map<string, number>
): void {
  const from = extractNode(fromToken.trim());
  const to = extractNode(toToken.trim());
  if (!from || !to) return;
  if (!nodeMap.has(from.id)) nodeMap.set(from.id, { label: from.label, shape: from.shape });
  if (!nodeMap.has(to.id)) nodeMap.set(to.id, { label: to.label, shape: to.shape });

  const key = `${from.id}::${to.id}`;
  const idx = edgeCounts.get(key) ?? 0;
  edgeCounts.set(key, idx + 1);
  edges.push({ id: `${from.id}::${to.id}::${idx}`, from: from.id, to: to.id, label, style: connectorToStyle(connector) });
}

function extractNode(token: string): { id: string; label: string; shape: NodeShape } | null {
  const m = token.match(
    /^([A-Za-z0-9_][A-Za-z0-9_-]*)(?:\[([^\]]*)\]|\{([^}]*)\}|\(\[([^\]]*)\]\)|\(\(([^)]*)\)\)|\(([^)]*)\))?$/
  );
  if (!m || !m[1]) return null;
  const id = m[1];
  const label = m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6] ?? id;
  let shape: NodeShape = 'rect';
  if (m[3] !== undefined) shape = 'diamond';
  else if (m[4] !== undefined) shape = 'stadium';
  else if (m[5] !== undefined) shape = 'circle';
  else if (m[6] !== undefined) shape = 'round';
  return { id, label, shape };
}

export function getFlowchartBlock(text: string): { start: number; end: number } | null {
  const re = /```mermaid[ \t]*\r?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (/^\s*(flowchart|graph)\s+/i.test(match[1])) {
      return { start: match.index, end: match.index + match[0].length };
    }
  }
  return null;
}
