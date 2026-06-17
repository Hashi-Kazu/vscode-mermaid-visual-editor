import { GanttData, GanttTask } from './types';

export function ganttToCode(data: GanttData): string {
  const lines: string[] = ['gantt'];
  if (data.title)      lines.push(`    title ${data.title}`);
  lines.push(`    dateFormat ${data.dateFormat || 'YYYY-MM-DD'}`);
  if (data.axisFormat) lines.push(`    axisFormat ${data.axisFormat}`);

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
  if (t.status) parts.push(t.status);
  if (t.id)     parts.push(t.id);
  parts.push(t.afterId ? `after ${t.afterId}` : t.startDate);
  parts.push(`${t.duration}d`);
  return `${t.label} :${parts.join(', ')}`;
}

/** Replace the gantt block in the original document text with new code. */
export function applyToDocument(docText: string, fileName: string, newGanttCode: string): string {
  if (fileName.endsWith('.mmd')) return newGanttCode;

  // Replace the first ```mermaid block that starts with gantt
  const replaced = docText.replace(
    /(```mermaid[ \t]*\r?\n)([\s\S]*?)(```)/,
    (_, open, body, close) => {
      if (body.trimStart().startsWith('gantt')) {
        return open + newGanttCode + '\n' + close;
      }
      return _ ;
    }
  );
  return replaced !== docText ? replaced : newGanttCode;
}
