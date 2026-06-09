import type { Services } from '../types.js';

export function buildProjectContext(services: Services, projectId: string): string {
  const project = services.projects.get(projectId);
  if (!project) {
    throw new Error('Project not found');
  }

  const allColumns = services.columns.list().sort((a, b) => a.position - b.position);
  const columnMap = new Map<string, string>();
  for (const col of allColumns) {
    columnMap.set(col.id, col.name);
  }

  const allItems = services.items.listByProject(projectId).slice(0, 200);
  const itemMap = new Map<string, string>();
  for (const item of allItems) {
    itemMap.set(item.id, item.title);
  }

  // Build context string
  const lines: string[] = [];

  lines.push(`PROJECT: ${project.name}`);
  lines.push(`DESCRIPTION: ${project.description || '(no description)'}`);
  lines.push('');
  lines.push('COLUMNS (in order):');
  for (const col of allColumns) {
    lines.push(`- ${col.position}. ${col.name} [id: ${col.id}]`);
  }
  lines.push('');

  if (allItems.length === 0) {
    lines.push('EXISTING ITEMS (0 total):');
    lines.push('(none yet)');
  } else {
    // Sort by type then title
    const sorted = [...allItems].sort((a, b) => {
      if (a.type < b.type) return -1;
      if (a.type > b.type) return 1;
      return a.title.localeCompare(b.title);
    });

    lines.push(`EXISTING ITEMS (${allItems.length} total):`);
    for (const item of sorted) {
      const columnName = columnMap.get(item.column_id) ?? item.column_id;
      let line = `- [${item.type.toUpperCase()}] ${item.title} (id: ${item.id}, column: ${columnName}`;
      if (item.parent_id) {
        const parentTitle = itemMap.get(item.parent_id);
        if (parentTitle) {
          line += `, parent: ${parentTitle}`;
        }
      }
      line += ')';
      lines.push(line);
    }
  }

  lines.push('');
  lines.push('ITEM HIERARCHY CONVENTION:');
  lines.push('- Epic: a large theme of work (multiple stories, weeks of effort). Create epics first.');
  lines.push('- Story: a coherent user-facing feature under an epic (days of effort). Set parent_id to the epic.');
  lines.push('- Task: a single concrete unit of work under a story or epic (hours). Set parent_id to the story or epic.');

  return lines.join('\n');
}
