import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Services } from '../../types.js';
import { EventTypes } from '../../types.js';
import { eventBus as defaultBus } from '../../events/bus.js';
import type { EventBus } from '../../events/bus.js';

export function registerProjectTools(server: McpServer, services: Services, bus: EventBus = defaultBus): void {
  server.tool(
    'ldash_list_projects',
    'List all projects in the ldash board. Call this first to discover available project IDs before using other tools. Returns id, name, description, and timestamps for each project.',
    {},
    async () => {
      const projects = services.projects.list();
      return { content: [{ type: 'text' as const, text: JSON.stringify(projects, null, 2) }] };
    }
  );

  // ldash_create_project
  server.tool(
    'ldash_create_project',
    'Create a new project on the ldash board. Use this when planning work for a repo that has no project yet — check with ldash_list_projects first to avoid duplicates. Returns the created project including its id, which is needed for all item operations.',
    {
      name: z.string().min(1).describe('Name of the project. Required and must not be empty. Typically the repo or product name.'),
      description: z.string().optional().describe('Short description of what the project is. Optional.'),
      repo_path: z.string().optional().describe("Absolute filesystem path to the project's repository on disk. Optional; shown in the board header with click-to-copy."),
    },
    async (input) => {
      const name = input.name.trim();
      if (name === '') {
        return { content: [{ type: 'text' as const, text: 'Error: name must not be empty' }], isError: true };
      }

      const repoPath = input.repo_path?.trim();
      const project = services.projects.create({
        name,
        description: input.description ?? '',
        repo_path: repoPath ? repoPath : null,
      });

      services.activity.append({
        project_id: project.id,
        actor_type: 'claude',
        actor_id: 'claude-code',
        event_type: EventTypes.PROJECT_CREATED,
        payload: { name: project.name },
      });

      bus.emit({
        type: 'project.created',
        projectId: project.id,
        entityId: project.id,
        data: { project },
      });

      return { content: [{ type: 'text' as const, text: JSON.stringify(project, null, 2) }] };
    }
  );
}
