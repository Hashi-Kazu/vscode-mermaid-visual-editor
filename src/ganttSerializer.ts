import { GanttData, GanttTask } from './types';
import { parseDate, fmt } from './ganttParser';

/** End date (exclusive) for a task = start + duration days, matching the
 *  parser's `duration = diffDays(start, end)` interpretation and Mermaid's
 *  default (non-inclusive) end-date behavior. */
function endDateExclusive(t: GanttTask): string {
  const d = parseDate(t.startDate);
  d.setDate(d.getDate() + t.duration);
  return fmt(d);
}

export function ganttToCode(data: GanttData): string {
  const lines: string[] = ['gantt'];
  if (data.title)      lines.push(`    title ${data.title}`);
  lines.push(`    dateFormat ${data.dateFormat || 'YYYY-MM-DD'}`);
  if (data.axisFormat) lines.push(`    axisFormat ${data.axisFormat}`);
  if (data.excludes && data.excludes.length > 0) lines.push(`    excludes ${data.excludes.join(', ')}`);

  data.sections.forEach((section, idx) => {
    if (section.name) {
      lines.push('');
      lines.push(`    section ${section.name}`);
    } else if (idx > 0) {
      // A non-leading unnamed section: emit an explicit boundary so the grouping
      // survives the round-trip. Without this, its tasks would merge into the
      // previous section on re-parse, losing structure. The leading unnamed
      // section (idx 0) needs no marker — pre-section tasks belong to it.
      lines.push('');
      lines.push('    section ');
    }
    for (const task of section.tasks) {
      lines.push(`        ${serializeTask(task)}`);
    }
  });
  return lines.join('\n');
}

function serializeTask(t: GanttTask): string {
  const parts: string[] = [];
  // Emit `crit` before other status keywords to match Mermaid convention.
  if (t.crit)   parts.push('crit');
  if (t.status) parts.push(t.status);
  if (t.id)     parts.push(t.id);
  if (t.afterId) {
    // Relative-start tasks stay `after <id>, Nd` — an end date after a relative
    // start is unstable in Mermaid, so never emit end-date form here.
    parts.push(`after ${t.afterId}`);
    parts.push(`${t.duration}d`);
  } else if (t.useEndDate && t.status !== 'milestone') {
    // Only tasks whose schedule was edited/created in the Web editor (or were
    // authored with an end date) serialize as `開始日, 終了日`.
    parts.push(t.startDate);
    parts.push(endDateExclusive(t));
  } else {
    // Untouched duration-form tasks and milestones keep `開始日, Nd`.
    parts.push(t.startDate);
    parts.push(`${t.duration}d`);
  }
  return `${t.label} :${parts.join(', ')}`;
}

/** Replace the gantt block in the original document text with new code. */
export function applyToDocument(docText: string, fileName: string, newGanttCode: string): string {
  if (fileName.endsWith('.mmd')) return newGanttCode;

  const hasFence = /```mermaid[ \t]*\r?\n/.test(docText);
  if (!hasFence) return newGanttCode;

  return docText.replace(
    /(```mermaid[ \t]*\r?\n)(?=\s*gantt\b)([\s\S]*?)(```)/i,
    (_, open, _body, close) => open + newGanttCode + '\n' + close
  );
}
