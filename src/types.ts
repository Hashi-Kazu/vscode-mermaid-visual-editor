export interface GanttData {
  title: string;
  dateFormat: string;
  axisFormat?: string;
  /** Mermaid `excludes` directive tokens (raw, trimmed, order/casing preserved).
   *  Supported tokens: `weekends`, weekday names (`monday`..`sunday`), `YYYY-MM-DD`.
   *  Used for display-only exclusion marking (R-G18); does not affect
   *  duration/afterId-based scheduling calculations. */
  excludes?: string[];
  sections: GanttSection[];
}

export interface GanttSection {
  name: string;
  tasks: GanttTask[];
}

export interface GanttTask {
  id: string;
  label: string;
  /** Primary status keyword: done / active / milestone / '' (unset).
   *  'crit' has been extracted to the separate `crit` flag so that
   *  critical path can be combined with done/active. */
  status: 'done' | 'active' | 'milestone' | '';
  /** Critical-path flag — maps to the Mermaid `crit` keyword.
   *  Independent of `status` so that e.g. done+crit is representable. */
  crit?: boolean;
  startDate: string; // YYYY-MM-DD
  duration: number;  // days
  afterId?: string;  // dependency: `after <id>`
  /** When true, this task is serialized as `開始日, 終了日(YYYY-MM-DD)` instead of
   *  `開始日, Nd`. Set per-task only when a task's schedule is edited (or created)
   *  in the Web editor, so untouched duration-form tasks are never converted on
   *  save. Parsing an end-date-form task also sets this so the form survives
   *  round-trips. Ignored for milestones and `afterId` tasks (always `Nd`). */
  useEndDate?: boolean;
}

// Extension → Webview (Gantt)
export type ExtToWeb =
  | { type: 'update'; gantt: GanttData }
  | { type: 'saved' }
  | { type: 'empty' };

// Webview → Extension (Gantt)
export type WebToExt =
  | { type: 'ready' }
  | { type: 'initGantt' }
  | { type: 'editTask'; si: number; ti: number; patch: Partial<GanttTask> }
  | { type: 'addTask'; si: number; afterTi: number; task: GanttTask }
  | { type: 'deleteTask'; si: number; ti: number }
  | { type: 'editSection'; si: number; name: string }
  | { type: 'addSection'; name: string }
  | { type: 'structuralEdit'; gantt: GanttData }
  | { type: 'save' };

// ── Flowchart types ──────────────────────────────────────────────────────────

export type EdgeStyle =
  | 'solid-arrow'      // A --> B
  | 'dotted-arrow'     // A -.-> B
  | 'thick-arrow'      // A ==> B
  | 'solid-no-arrow'   // A --- B
  | 'dotted-no-arrow'; // A -.- B

export interface FlowchartData {
  direction: 'TD' | 'LR' | 'BT' | 'RL';
  keyword: 'flowchart' | 'graph';
  nodes: FlowchartNode[];
  edges: FlowchartEdge[];
}

export type NodeShape = 'rect' | 'round' | 'diamond' | 'stadium' | 'circle';

export interface FlowchartNode {
  id: string;
  label: string;
  shape: NodeShape;
}

export interface FlowchartEdge {
  id: string;      // `${from}::${to}::${idx}` for disambiguation
  from: string;
  to: string;
  label?: string;
  style?: EdgeStyle;
}

// Extension → Webview (Flowchart)
export type FlowExtToWeb =
  | { type: 'update'; rawCode: string; isDark: boolean }
  | { type: 'saved' }
  | { type: 'empty' }
  | { type: 'parseError'; message: string };

// Webview → Extension (Flowchart)
export type FlowWebToExt =
  | { type: 'ready' }
  | { type: 'initFlowchart' }
  | { type: 'editNode'; nodeId: string; label: string }
  | { type: 'addNode'; x?: number; y?: number }
  | { type: 'deleteNode'; nodeId: string }
  | { type: 'changeNodeShape'; nodeId: string; shape: NodeShape }
  | { type: 'addEdge'; from: string; to: string; style?: EdgeStyle }
  | { type: 'editEdge'; from: string; to: string; idx: number; label: string }
  | { type: 'deleteEdge'; from: string; to: string; idx: number }
  | { type: 'changeEdgeStyle'; from: string; to: string; idx: number; style: EdgeStyle }
  | { type: 'changeDirection'; direction: string }
  | { type: 'undo'; code: string }
  | { type: 'save' }
  | { type: 'switchType'; diagramType: 'gantt' | 'flowchart' }
  | { type: 'export'; format: 'svg' | 'png'; data: string };
