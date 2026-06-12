import { Hono } from 'hono';
import type { KbService } from '../services/kb.js';
import type { ProjectService } from '../services/projects.js';

function makeError(msg: string, status: number): Error {
  const err = new Error(msg) as Error & { status: number };
  err.status = status;
  return err;
}

export function projectKbRouter(kbService: KbService, projectService: ProjectService): Hono {
  const app = new Hono();

  // GET /api/projects/:projectId/kb
  app.get('/', (c) => {
    const projectId = c.req.param('projectId') as string;
    const project = projectService.get(projectId);
    if (!project) {
      throw makeError('Project not found', 404);
    }
    return c.json(kbService.list(projectId));
  });

  // GET /api/projects/:projectId/kb/search?q=term
  app.get('/search', (c) => {
    const projectId = c.req.param('projectId') as string;
    const project = projectService.get(projectId);
    if (!project) {
      throw makeError('Project not found', 404);
    }

    const q = c.req.query('q');
    if (!q || q.trim() === '') {
      throw makeError('q is required and must be a non-empty string', 400);
    }

    return c.json(kbService.search(projectId, q));
  });

  // POST /api/projects/:projectId/kb
  app.post('/', async (c) => {
    const projectId = c.req.param('projectId') as string;
    const project = projectService.get(projectId);
    if (!project) {
      throw makeError('Project not found', 404);
    }

    const body = await c.req.json().catch(() => ({}));
    const { title, content } = body as { title?: unknown; content?: unknown };

    if (!title || typeof title !== 'string' || title.trim() === '') {
      throw makeError('title is required and must be a non-empty string', 400);
    }
    if (content !== undefined && typeof content !== 'string') {
      throw makeError('content must be a string', 400);
    }

    const doc = kbService.create({
      project_id: projectId,
      title: title.trim(),
      content: typeof content === 'string' ? content : '',
    });

    return c.json(doc, 201);
  });

  return app;
}

export function kbRouter(kbService: KbService): Hono {
  const app = new Hono();

  // GET /api/kb/:id
  app.get('/:id', (c) => {
    const { id } = c.req.param();
    const doc = kbService.get(id);
    if (!doc) {
      throw makeError('Document not found', 404);
    }
    return c.json(doc);
  });

  // PATCH /api/kb/:id
  app.patch('/:id', async (c) => {
    const { id } = c.req.param();
    const existing = kbService.get(id);
    if (!existing) {
      throw makeError('Document not found', 404);
    }

    const body = await c.req.json().catch(() => ({}));
    const { title, content } = body as { title?: unknown; content?: unknown };

    const updateData: Partial<{ title: string; content: string }> = {};

    if (title !== undefined) {
      if (typeof title !== 'string' || title.trim() === '') {
        throw makeError('title must be a non-empty string', 400);
      }
      updateData.title = title.trim();
    }
    if (content !== undefined) {
      if (typeof content !== 'string') {
        throw makeError('content must be a string', 400);
      }
      updateData.content = content;
    }

    if (Object.keys(updateData).length === 0) {
      throw makeError('Body must contain at least one of: title, content', 400);
    }

    const updated = kbService.update(id, updateData);
    return c.json(updated);
  });

  // DELETE /api/kb/:id
  app.delete('/:id', (c) => {
    const { id } = c.req.param();
    const existing = kbService.get(id);
    if (!existing) {
      throw makeError('Document not found', 404);
    }
    kbService.delete(id);
    return new Response(null, { status: 204 });
  });

  return app;
}
