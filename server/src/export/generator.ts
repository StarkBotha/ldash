import type { Services } from '../types.js';
import { slugify } from '../utils/slugify.js';

export interface ExportFile {
  relativePath: string;
  content: string;
}

export function generateExport(services: Services, projectId: string): ExportFile[] {
  const project = services.projects.get(projectId);
  if (!project) {
    throw new Error('Project not found');
  }

  const allColumns = services.columns.list();
  const columnMap = new Map<string, string>();
  for (const col of allColumns) {
    columnMap.set(col.id, col.name);
  }

  const allItems = services.items.listByProject(projectId);
  const itemMap = new Map(allItems.map((item) => [item.id, item]));

  const epics = allItems.filter((i) => i.type === 'epic').sort((a, b) => a.position - b.position);
  const stories = allItems.filter((i) => i.type === 'story');
  const tasks = allItems.filter((i) => i.type === 'task');

  const files: ExportFile[] = [];

  // Identify orphans: stories/tasks whose parent_id is not null but the parent doesn't exist in this project
  const orphans = [...stories, ...tasks].filter((item) => {
    if (!item.parent_id) return true; // no parent set — this is an orphan for stories/tasks
    return !itemMap.has(item.parent_id);
  });

  // Build project README.md
  const readmeLines: string[] = [];
  readmeLines.push(`# ${project.name}`);
  readmeLines.push('');
  readmeLines.push(project.description || '(No description.)');
  readmeLines.push('');
  readmeLines.push('## Epics');
  readmeLines.push('');

  for (const epic of epics) {
    const columnName = columnMap.get(epic.column_id) ?? epic.column_id;
    const epicSlug = slugify(epic.title);
    readmeLines.push(`- [${columnName}] [${epic.title}](./epic-${epicSlug}/README.md)`);
  }

  readmeLines.push('');
  readmeLines.push('## Export info');
  readmeLines.push('');
  readmeLines.push(`Generated: ${new Date().toISOString()}`);
  readmeLines.push(`Total items: ${allItems.length}`);

  files.push({ relativePath: 'README.md', content: readmeLines.join('\n') });

  // Build one file per epic
  for (const epic of epics) {
    const epicSlug = slugify(epic.title);
    const epicColumnName = columnMap.get(epic.column_id) ?? epic.column_id;

    const epicLines: string[] = [];
    epicLines.push(`# ${epic.title}`);
    epicLines.push('');
    epicLines.push(`**Status:** ${epicColumnName}`);
    epicLines.push('');
    epicLines.push(epic.description || '_No description._');
    epicLines.push('');
    epicLines.push('## Stories');
    epicLines.push('');

    const epicStories = stories
      .filter((s) => s.parent_id === epic.id)
      .sort((a, b) => a.position - b.position);

    if (epicStories.length === 0) {
      epicLines.push('_No stories yet._');
    } else {
      for (const story of epicStories) {
        const storyColumnName = columnMap.get(story.column_id) ?? story.column_id;
        epicLines.push(`### ${story.title}`);
        epicLines.push('');
        epicLines.push(`**Status:** ${storyColumnName}`);
        epicLines.push('');
        epicLines.push(story.description || '_No description._');
        epicLines.push('');

        const storyTasks = tasks
          .filter((t) => t.parent_id === story.id)
          .sort((a, b) => a.position - b.position);

        if (storyTasks.length > 0) {
          epicLines.push('#### Tasks');
          epicLines.push('');
          for (const task of storyTasks) {
            const taskColumnName = columnMap.get(task.column_id) ?? task.column_id;
            epicLines.push(`- [${taskColumnName}] **${task.title}**`);
            if (task.description && task.description.trim() !== '') {
              epicLines.push(`  ${task.description}`);
            }
          }
          epicLines.push('');
        }

        epicLines.push('---');
        epicLines.push('');
      }
    }

    files.push({
      relativePath: `epic-${epicSlug}/README.md`,
      content: epicLines.join('\n'),
    });
  }

  // Build orphans.md if there are any orphaned items
  if (orphans.length > 0) {
    const orphanLines: string[] = [];
    orphanLines.push('# Orphaned Items');
    orphanLines.push('');
    orphanLines.push('These items have a parent_id that does not match any item in this project.');
    orphanLines.push('');

    for (const orphan of orphans) {
      const columnName = columnMap.get(orphan.column_id) ?? orphan.column_id;
      orphanLines.push(`- [${orphan.type}] **${orphan.title}** (status: ${columnName})`);
    }

    files.push({ relativePath: 'orphans.md', content: orphanLines.join('\n') });
  }

  return files;
}
