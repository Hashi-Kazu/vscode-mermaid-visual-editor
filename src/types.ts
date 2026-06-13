export interface GanttData {
  title: string;
  dateFormat: string;
  axisFormat?: string;
  sections: GanttSection[];
}

export interface GanttSection {
  name: string;
  tasks: GanttTask[];
}

export interface GanttTask {
  id: string;
  label: string;
  status: 'done' | 'active' | 'crit' | 'milestone' | '';
  startDate: string; // YYYY-MM-DD
  duration: number;  // days
  afterId?: string;  // dependency: `after <id>`
}

// Extension → Webview
export type ExtToWeb =
  | { type: 'update'; gantt: GanttData }
  | { type: 'saved' }
  | { type: 'empty' };

// Webview → Extension
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
