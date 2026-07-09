import { GanttData, GanttSection, GanttTask } from './types';

/** Keywords that map to GanttTask.status (single-select). */
const STATUS_WORDS = ['done', 'active', 'milestone'] as const;
/** `crit` is extracted as a separate boolean flag (combinable with status). */
const CRIT_WORD = 'crit';

export function parseGantt(text: string): GanttData | null {
  const block = getGanttBlock(text);
  if (block) {
    const match = text.slice(block.start, block.end).match(/```mermaid[ \t]*\r?\n([\s\S]*?)```/);
    return parseGanttCode(match![1]);
  }
  if (/```mermaid[ \t]*\r?\n/.test(text)) return null;
  return parseGanttCode(text);
}

export function getGanttBlock(text: string): { start: number; end: number } | null {
  const re = /```mermaid[ \t]*\r?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (/^\s*gantt\b/i.test(match[1])) {
      return { start: match.index, end: match.index + match[0].length };
    }
  }
  return null;
}

function parseGanttCode(code: string): GanttData | null {
  const lines = code.split('\n').map(l => l.trimEnd());
  const ganttIdx = lines.findIndex(l => l.trim() === 'gantt');
  if (ganttIdx === -1) return null;

  const data: GanttData = { title: '', dateFormat: 'YYYY-MM-DD', sections: [] };
  const taskById = new Map<string, string>(); // id → endDate

  // The leading section is an implicit placeholder for any pre-`section` tasks.
  // It is only kept if tasks actually land in it (see filter below). Sections
  // introduced by an explicit `section` line are always preserved, even when
  // empty, so user-created empty sections survive the round-trip.
  let current: GanttSection = { name: '', tasks: [] };
  const leadingPlaceholder: GanttSection = current;
  data.sections.push(current);

  for (let i = ganttIdx + 1; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (!t || t.startsWith('%%')) continue;

    if (t.startsWith('title '))           { data.title = t.slice(6).trim(); continue; }
    if (t.startsWith('dateFormat'))        { data.dateFormat = t.slice(10).trim(); continue; }
    if (t.startsWith('axisFormat'))        { data.axisFormat = t.slice(10).trim(); continue; }
    if (t.startsWith('excludes')) {
      const tokens = t.slice(8).trim().split(',').map(s => s.trim()).filter(Boolean);
      data.excludes = [...(data.excludes ?? []), ...tokens];
      continue;
    }
    if (t.startsWith('todayMarker') ||
        t.startsWith('inclusiveEndDates')) { continue; }

    // Match `section` followed by a space or end-of-line (prevents
    // accidentally treating `sectionFoo` task labels as section headers).
    if (t === 'section' || t.startsWith('section ')) {
      const name = t.slice(7).trim();
      current = { name, tasks: [] };
      data.sections.push(current);
      continue;
    }

    if (t.includes(':')) {
      const task = parseTaskLine(t, taskById);
      if (task) {
        if (task.id) taskById.set(task.id, endDate(task));
        current.tasks.push(task);
      }
    }
  }

  // Drop only the implicit leading placeholder when nothing landed in it.
  // Explicit sections (named or unnamed) are always preserved so that
  // user-created empty sections survive a save/parse round-trip.
  if (leadingPlaceholder.tasks.length === 0) {
    data.sections = data.sections.filter(s => s !== leadingPlaceholder);
  }
  if (data.sections.length === 0) data.sections = [{ name: '', tasks: [] }];
  return data;
}

function parseTaskLine(line: string, taskById: Map<string, string>): GanttTask | null {
  const colon = line.indexOf(':');
  if (colon === -1) return null;

  const label = line.slice(0, colon).trim();
  const parts = line.slice(colon + 1).split(',').map(p => p.trim()).filter(Boolean);

  const isDateStr = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  const isAfter   = (s: string) => s.startsWith('after ');
  const isDur     = (s: string) => /^\d+[dwhmsDWHMS]$/.test(s);

  let status: GanttTask['status'] = '';
  let crit = false;
  let id = '';
  let startStr = '';
  let duration = 7;
  let idx = 0;

  // Consume all leading keyword tokens (crit / done / active / milestone).
  // Mermaid allows combinations such as `crit, done` or `active, crit`.
  while (parts[idx]) {
    const p = parts[idx];
    if (p === CRIT_WORD) {
      crit = true;
      idx++;
    } else if ((STATUS_WORDS as readonly string[]).includes(p)) {
      status = p as GanttTask['status'];
      idx++;
    } else {
      break;
    }
  }

  if (parts[idx] && !isDateStr(parts[idx]) && !isAfter(parts[idx]) && !isDur(parts[idx])) {
    id = parts[idx++];
  }

  if (parts[idx]) startStr = parts[idx++];

  if (parts[idx]) {
    const d = parts[idx];
    if (isDur(d)) {
      const n = parseInt(d);
      if (d.endsWith('w') || d.endsWith('W'))       duration = n * 7;
      else if (d.endsWith('h') || d.endsWith('H'))   duration = Math.max(1, Math.ceil(n / 24));
      else                                             duration = Math.max(status === 'milestone' ? 0 : 1, n);
    } else if (isDateStr(d)) {
      const resolved = resolveStart(startStr, taskById);
      duration = Math.max(1, diffDays(resolved, d));
    }
  }

  const startDate = resolveStart(startStr, taskById);
  const afterId = startStr.startsWith('after ') ? startStr.slice(6).trim() : undefined;
  return {
    id, label, status,
    ...(crit ? { crit: true } : {}),
    startDate, duration,
    ...(afterId ? { afterId } : {}),
  };
}

function resolveStart(s: string, taskById: Map<string, string>): string {
  if (!s) return fmt(new Date());
  if (s.startsWith('after ')) {
    const ref = s.slice(6).trim();
    return taskById.get(ref) ?? fmt(new Date());
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return fmt(new Date());
}

function endDate(t: GanttTask): string {
  const d = parseDate(t.startDate);
  d.setDate(d.getDate() + t.duration);
  return fmt(d);
}

export function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function fmt(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function diffDays(a: string, b: string): number {
  return Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / 86400000);
}
