import { Hono } from 'hono';
import type { ProjectService } from '../services/projects.js';
import type { ActivityService } from '../services/activity.js';
import { EventTypes } from '../types.js';

function makeError(msg: string, status: number): Error {
  const err = new Error(msg) as Error & { status: number };
  err.status = status;
  return err;
}

export function projectsRouter(
  projectService: ProjectService,
  activityService: ActivityService
): Hono {
  const app = new Hono();

  // GET /api/projects
  app.get('/', (c) => {
    return c.json(projectService.list());
  });

  // POST /api/projects
  app.post('/', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { name, description } = body as { name?: unknown; description?: unknown };

    if (!name || typeof name !== 'string' || name.trim() === '') {
      throw makeError('name is required and must be a non-empty string', 400);
    }

    const project = projectService.create({
      name: name.trim(),
      description: typeof description === 'string' ? description : '',
    });

    activityService.append({
      project_id: project.id,
      event_type: EventTypes.PROJECT_CREATED,
      payload: { name: project.name },
    });

    return c.json(project, 201);
  });

  // GET /api/projects/:id
  app.get('/:id', (c) => {
    const { id } = c.req.param();
    const project = projectService.get(id);
    if (!project) {
      throw makeError('Project not found', 404);
    }
    return c.json(project);
  });

  // PATCH /api/projects/:id
  app.patch('/:id', async (c) => {
    const { id } = c.req.param();

    const existing = projectService.get(id);
    if (!existing) {
      throw makeError('Project not found', 404);
    }

    const body = await c.req.json().catch(() => ({}));
    const { name, description } = body as { name?: unknown; description?: unknown };

    const updateData: Partial<{ name: string; description: string }> = {};
    const oldFields: Record<string, unknown> = {};
    const newFields: Record<string, unknown> = {};

    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim() === '') {
        throw makeError('name must be a non-empty string', 400);
      }
      updateData.name = name.trim();
      oldFields.name = existing.name;
      newFields.name = updateData.name;
    }
    if (description !== undefined) {
      if (typeof description !== 'string') {
        throw makeError('description must be a string', 400);
      }
      updateData.description = description;
      oldFields.description = existing.description;
      newFields.description = description;
    }

    if (Object.keys(updateData).length === 0) {
      throw makeError('Body must contain at least one of: name, description', 400);
    }

    const updated = projectService.update(id, updateData);

    activityService.append({
      project_id: id,
      event_type: EventTypes.PROJECT_UPDATED,
      payload: { fields: { old: oldFields, new: newFields } },
    });

    return c.json(updated);
  });

  // DELETE /api/projects/:id
  app.delete('/:id', (c) => {
    const { id } = c.req.param();

    const existing = projectService.get(id);
    if (!existing) {
      throw makeError('Project not found', 404);
    }

    // Write activity BEFORE deletion so project_id FK is still valid
    activityService.append({
      project_id: id,
      event_type: EventTypes.PROJECT_DELETED,
      payload: { name: existing.name },
    });

    projectService.delete(id);
    return new Response(null, { status: 204 });
  });

  return app;
}
