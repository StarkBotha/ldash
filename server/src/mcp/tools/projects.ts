import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Services } from '../../types.js';

export function registerProjectTools(server: McpServer, services: Services): void {
  server.tool(
    'ldash_list_projects',
    'List all projects in the ldash board. Call this first to discover available project IDs before using other tools. Returns id, name, description, and timestamps for each project.',
    {},
    async () => {
      const projects = services.projects.list();
      return { content: [{ type: 'text' as const, text: JSON.stringify(projects, null, 2) }] };
    }
  );
}
