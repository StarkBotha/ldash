import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runSchema } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrationRunner.js';
import { seedColumns } from '../../src/db/seed.js';
import { ProjectService } from '../../src/services/projects.js';
import { ColumnService } from '../../src/services/columns.js';
import { ItemService } from '../../src/services/items.js';
import { CommentService } from '../../src/services/comments.js';
import { ActivityService } from '../../src/services/activity.js';
import { ConversationService } from '../../src/services/conversations.js';
import { SettingsService } from '../../src/services/settings.js';
import { generateExport } from '../../src/export/generator.js';
import type { Services } from '../../src/types.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runSchema(db);
  runMigrations(db);
  seedColumns(db);
  return db;
}

function createServices(db: Database.Database): Services {
  return {
    projects: new ProjectService(db),
    items: new ItemService(db),
    columns: new ColumnService(db),
    comments: new CommentService(db),
    activity: new ActivityService(db),
    conversations: new ConversationService(db),
    settings: new SettingsService(db),
  };
}

function setupTestData(services: Services) {
  const project = services.projects.create({ name: 'Test Project', description: 'A test project' });
  const columns = services.columns.list();
  const backlogCol = columns.find((c) => c.name === 'Backlog')!;
  const doneCol = columns.find((c) => c.name === 'Done')!;

  const epic1 = services.items.create({
    project_id: project.id,
    type: 'epic',
    title: 'Epic One',
    column_id: backlogCol.id,
  });
  const epic2 = services.items.create({
    project_id: project.id,
    type: 'epic',
    title: 'Epic Two',
    column_id: backlogCol.id,
  });

  const story1 = services.items.create({
    project_id: project.id,
    type: 'story',
    title: 'Story One',
    column_id: backlogCol.id,
    parent_id: epic1.id,
  });
  const story2 = services.items.create({
    project_id: project.id,
    type: 'story',
    title: 'Story Two',
    column_id: backlogCol.id,
    parent_id: epic2.id,
  });

  const task1 = services.items.create({
    project_id: project.id,
    type: 'task',
    title: 'Task One',
    column_id: backlogCol.id,
    parent_id: story1.id,
  });
  const task2 = services.items.create({
    project_id: project.id,
    type: 'task',
    title: 'Task Two',
    column_id: backlogCol.id,
    parent_id: story1.id,
  });
  const task3 = services.items.create({
    project_id: project.id,
    type: 'task',
    title: 'Task Three',
    column_id: backlogCol.id,
    parent_id: story2.id,
  });

  return { project, backlogCol, doneCol, epic1, epic2, story1, story2, task1, task2, task3 };
}

describe('generateExport', () => {
  it('returns a README.md file', () => {
    const db = createTestDb();
    const services = createServices(db);
    const { project, epic1 } = setupTestData(services);

    const files = generateExport(services, project.id);

    const readme = files.find((f) => f.relativePath === 'README.md');
    expect(readme).toBeDefined();
    expect(readme!.content).toContain(project.name);
    expect(readme!.content).toContain(epic1.title);
  });

  it('returns one file per epic', () => {
    const db = createTestDb();
    const services = createServices(db);
    const { project } = setupTestData(services);

    const files = generateExport(services, project.id);

    const epicFiles = files.filter(
      (f) => f.relativePath.endsWith('/README.md') && f.relativePath !== 'README.md'
    );
    expect(epicFiles).toHaveLength(2);
  });

  it('epic file contains its stories and tasks', () => {
    const db = createTestDb();
    const services = createServices(db);
    const { project, epic1, story1, task1, task2 } = setupTestData(services);

    const files = generateExport(services, project.id);

    // Find the file for epic1
    const epicFile = files.find((f) => f.relativePath.includes('epic-one'));
    expect(epicFile).toBeDefined();
    expect(epicFile!.content).toContain(story1.title);
    expect(epicFile!.content).toContain(task1.title);
    expect(epicFile!.content).toContain(task2.title);
  });

  it('items with no parent epic are not listed in the project README epic list and orphans.md is generated', () => {
    const db = createTestDb();
    const services = createServices(db);
    const { project } = setupTestData(services);
    const columns = services.columns.list();
    const backlogCol = columns.find((c) => c.name === 'Backlog')!;

    // Create orphan story (no parent)
    services.items.create({
      project_id: project.id,
      type: 'story',
      title: 'Orphan Story',
      column_id: backlogCol.id,
      parent_id: null,
    });

    const files = generateExport(services, project.id);

    const readme = files.find((f) => f.relativePath === 'README.md');
    // README epic list shouldn't contain 'Orphan Story' as a link
    expect(readme!.content).not.toContain('./epic-orphan-story');

    const orphanFile = files.find((f) => f.relativePath === 'orphans.md');
    expect(orphanFile).toBeDefined();
    expect(orphanFile!.content).toContain('Orphan Story');
  });

  it('orphans.md is not generated when there are no orphans', () => {
    const db = createTestDb();
    const services = createServices(db);
    const { project } = setupTestData(services);

    const files = generateExport(services, project.id);

    const orphanFile = files.find((f) => f.relativePath === 'orphans.md');
    expect(orphanFile).toBeUndefined();
  });

  it('slugify produces filesystem-safe paths', () => {
    const db = createTestDb();
    const services = createServices(db);
    const project = services.projects.create({ name: 'Slug Test', description: '' });
    const columns = services.columns.list();
    const backlogCol = columns.find((c) => c.name === 'Backlog')!;

    services.items.create({
      project_id: project.id,
      type: 'epic',
      title: 'User Auth & Session Management!',
      column_id: backlogCol.id,
    });

    const files = generateExport(services, project.id);

    const epicFile = files.find(
      (f) => f.relativePath.endsWith('/README.md') && f.relativePath !== 'README.md'
    );
    expect(epicFile).toBeDefined();
    // Should not contain & or !
    expect(epicFile!.relativePath).not.toContain('&');
    expect(epicFile!.relativePath).not.toContain('!');
    // Should be filesystem-safe
    expect(epicFile!.relativePath).toMatch(/^epic-[a-z0-9-]+\/README\.md$/);
  });

  it('items with flagged === true are not excluded', () => {
    const db = createTestDb();
    const services = createServices(db);
    const project = services.projects.create({ name: 'Flag Test', description: '' });
    const columns = services.columns.list();
    const backlogCol = columns.find((c) => c.name === 'Backlog')!;

    const epic = services.items.create({
      project_id: project.id,
      type: 'epic',
      title: 'Flagged Epic',
      column_id: backlogCol.id,
    });
    // Flag the epic
    services.items.setFlag(epic.id, true);

    const files = generateExport(services, project.id);

    const readme = files.find((f) => f.relativePath === 'README.md');
    expect(readme!.content).toContain('Flagged Epic');
    const epicFile = files.find(
      (f) => f.relativePath.endsWith('/README.md') && f.relativePath !== 'README.md'
    );
    expect(epicFile).toBeDefined();
  });

  it('column status appears in item output', () => {
    const db = createTestDb();
    const services = createServices(db);
    const project = services.projects.create({ name: 'Status Test', description: '' });
    const columns = services.columns.list();
    const doneCol = columns.find((c) => c.name === 'Done')!;
    const backlogCol = columns.find((c) => c.name === 'Backlog')!;

    const epic = services.items.create({
      project_id: project.id,
      type: 'epic',
      title: 'Done Epic',
      column_id: doneCol.id,
    });

    services.items.create({
      project_id: project.id,
      type: 'story',
      title: 'Done Story',
      column_id: doneCol.id,
      parent_id: epic.id,
    });

    const files = generateExport(services, project.id);

    const epicFile = files.find(
      (f) => f.relativePath.endsWith('/README.md') && f.relativePath !== 'README.md'
    );
    expect(epicFile).toBeDefined();
    expect(epicFile!.content).toContain('Done');
  });
});
