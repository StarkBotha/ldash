import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Services } from '../../types.js';
import type { KbDocument } from '../../types.js';

const CLAUDE_ACTOR = { actor_type: 'claude' as const, actor_id: 'claude-code' };

/** Resolve a doc reference that may be an id, a key (e.g. LDA-KB-1), or a title (case-insensitive, within project). */
function resolveDoc(services: Services, projectId: string, ref: string): KbDocument | undefined {
  const byId = services.kb.get(ref);
  if (byId && byId.project_id === projectId) return byId;
  const byKey = services.kb.getByKey(ref);
  if (byKey && byKey.project_id === projectId) return byKey;
  return services.kb.getByTitle(projectId, ref);
}

export function registerKbTools(server: McpServer, services: Services): void {
  // ldash_save_kb_doc
  server.tool(
    'ldash_save_kb_doc',
    'Save a knowledgebase document for a project. The knowledgebase is the place to persist useful project knowledge so future agents and humans can find it: architecture overviews, how-tos, runbooks, hosting and deployment info, gotchas, and diagrams (mermaid code blocks are supported in the markdown). This is an UPSERT keyed on title: if a document with the same title already exists in the project (case-insensitive match), its content is replaced and the title is updated to the casing you provide; otherwise a new document is created. Save knowledge here whenever you learn something about the project worth keeping.',
    {
      project_id: z.string().describe('The id of the project this document belongs to.'),
      title: z.string().min(1).describe('Document title, e.g. "Architecture overview" or "Deploy runbook". Used as the upsert key (case-insensitive). Required and must not be empty.'),
      content: z.string().describe('Full markdown content of the document. Mermaid diagrams are supported via ```mermaid code blocks. Replaces any existing content entirely.'),
    },
    async (input) => {
      const project = services.projects.get(input.project_id);
      if (!project) {
        return { content: [{ type: 'text' as const, text: 'Error: project not found' }], isError: true };
      }
      if (input.title.trim() === '') {
        return { content: [{ type: 'text' as const, text: 'Error: title must not be empty' }], isError: true };
      }

      const existing = services.kb.getByTitle(input.project_id, input.title.trim());
      if (existing) {
        const doc = services.kb.update(existing.id, { title: input.title.trim(), content: input.content }, CLAUDE_ACTOR);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ id: doc.id, key: doc.key, title: doc.title, action: 'updated' }) }] };
      }

      const doc = services.kb.create(
        { project_id: input.project_id, title: input.title.trim(), content: input.content },
        CLAUDE_ACTOR
      );
      return { content: [{ type: 'text' as const, text: JSON.stringify({ id: doc.id, key: doc.key, title: doc.title, action: 'created' }) }] };
    }
  );

  // ldash_get_kb_doc
  server.tool(
    'ldash_get_kb_doc',
    'Read a knowledgebase document from a project. The knowledgebase holds persisted project knowledge: architecture notes, how-tos, runbooks, hosting info, and mermaid diagrams. Check it before starting work on an unfamiliar area — earlier agents may already have documented what you need. Accepts either a document id or a document title (case-insensitive match within the project). Returns the full document including its markdown content.',
    {
      project_id: z.string().describe('The id of the project to look in.'),
      doc: z.string().describe('The document to fetch — its key (e.g. "LDA-KB-1"), its id, or its title (case-insensitive).'),
    },
    async (input) => {
      const project = services.projects.get(input.project_id);
      if (!project) {
        return { content: [{ type: 'text' as const, text: 'Error: project not found' }], isError: true };
      }

      const doc = resolveDoc(services, input.project_id, input.doc);
      if (!doc) {
        return { content: [{ type: 'text' as const, text: 'Error: document not found' }], isError: true };
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify(doc, null, 2) }] };
    }
  );

  // ldash_list_kb_docs
  server.tool(
    'ldash_list_kb_docs',
    'List the knowledgebase documents in a project (key and title only, no content). Each document has an immutable key like "LDA-KB-1" that can be quoted to refer to it. The knowledgebase holds persisted project knowledge: architecture notes, how-tos, runbooks, hosting info, and diagrams. List it at the start of work to see what is already documented, then use ldash_get_kb_doc to read a specific document by its key.',
    {
      project_id: z.string().describe('The id of the project whose knowledgebase to list.'),
    },
    async (input) => {
      const project = services.projects.get(input.project_id);
      if (!project) {
        return { content: [{ type: 'text' as const, text: 'Error: project not found' }], isError: true };
      }

      const docs = services.kb.list(input.project_id).map((d) => ({ id: d.id, key: d.key, title: d.title, updated_at: d.updated_at }));
      return { content: [{ type: 'text' as const, text: JSON.stringify(docs, null, 2) }] };
    }
  );

  // ldash_search_kb_docs
  server.tool(
    'ldash_search_kb_docs',
    'Search knowledgebase documents by free text. Matches against document titles AND markdown content (case-insensitive substring) and returns a snippet of content around the first match for each hit. Use this to find which document covers a topic, then read it with ldash_get_kb_doc. The default is a per-project search of the current working project: pass its id as project_id. Only when the user has explicitly asked to consult another project\'s knowledgebase or to search across all projects — never by default — pass that other project\'s id (resolve names to ids via ldash_list_projects) or omit project_id entirely for an all-projects search; all-projects results include each hit\'s project_name.',
    {
      project_id: z.string().optional().describe('The id of the project whose knowledgebase to search. Pass the current working project\'s id by default. Omit ONLY for an explicitly requested all-projects search.'),
      query: z.string().min(1).describe('Text to search for in document titles and content. Required and must not be empty.'),
    },
    async (input) => {
      if (input.query.trim() === '') {
        return { content: [{ type: 'text' as const, text: 'Error: query must not be empty' }], isError: true };
      }

      if (input.project_id === undefined) {
        const results = services.kb
          .searchAll(input.query)
          .map((r) => ({ id: r.id, key: r.key, project_name: r.project_name, title: r.title, snippet: r.snippet, updated_at: r.updated_at }));
        return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
      }

      const project = services.projects.get(input.project_id);
      if (!project) {
        return { content: [{ type: 'text' as const, text: 'Error: project not found' }], isError: true };
      }

      const results = services.kb
        .search(input.project_id, input.query)
        .map((r) => ({ id: r.id, key: r.key, title: r.title, snippet: r.snippet, updated_at: r.updated_at }));
      return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
    }
  );

  // ldash_delete_kb_doc
  server.tool(
    'ldash_delete_kb_doc',
    'Delete a knowledgebase document from a project. Use this only when a document is obsolete or was created by mistake — prefer updating a document with ldash_save_kb_doc over deleting it. Accepts either a document id or a document title (case-insensitive match within the project).',
    {
      project_id: z.string().describe('The id of the project the document belongs to.'),
      doc: z.string().describe('The document to delete — its key (e.g. "LDA-KB-1"), its id, or its title (case-insensitive).'),
    },
    async (input) => {
      const project = services.projects.get(input.project_id);
      if (!project) {
        return { content: [{ type: 'text' as const, text: 'Error: project not found' }], isError: true };
      }

      const doc = resolveDoc(services, input.project_id, input.doc);
      if (!doc) {
        return { content: [{ type: 'text' as const, text: 'Error: document not found' }], isError: true };
      }

      services.kb.delete(doc.id, CLAUDE_ACTOR);
      return { content: [{ type: 'text' as const, text: `Deleted knowledgebase document "${doc.title}" (${doc.id})` }] };
    }
  );
}
