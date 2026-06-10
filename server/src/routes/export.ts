import { Hono } from 'hono';
import { resolve } from 'node:path';
import { cwd } from 'node:process';
import type { Services } from '../types.js';
import { generateExport } from '../export/generator.js';
import { writeExport } from '../export/writer.js';
import { slugify } from '../utils/slugify.js';
import { createLogger } from '../logger.js';

const logger = createLogger('export');

export function createExportRouter(services: Services): Hono {
  const app = new Hono();

  app.post('/api/projects/:projectId/export', async (c) => {
    const projectId = c.req.param('projectId');

    const project = services.projects.get(projectId);
    if (!project) {
      return c.json({ error: 'Project not found' }, 404);
    }

    logger.info('export requested', { projectId });

    const slugifiedName = slugify(project.name);
    const outputDir = resolve(cwd(), 'exports', slugifiedName);

    let files;
    try {
      files = generateExport(services, projectId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 500);
    }

    try {
      await writeExport(files, outputDir);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 500);
    }

    const paths = files.map(f => f.relativePath);
    logger.info('files written', { projectId, count: files.length });
    logger.debug('written paths', { paths });

    return c.json({ outputDir, fileCount: files.length });
  });

  return app;
}
