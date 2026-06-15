import type { ToolDefinition } from '../gateway/types.js';
import type { ToolHandler } from '../gateway/loop.js';
import type { Services, KbDocument } from '../types.js';

const KB_CHAT_ACTOR = { actor_type: 'llm' as const, actor_id: 'kb-chat-llm' };

// The whole-knowledgebase chat can search, read, list, and write (create or
// "touch up") the current project's KB documents. All operations are scoped to
// the conversation's project — the chat never reaches into another project's KB.
export function getKbChatToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'search_kb_docs',
      description:
        'Search this project\'s knowledgebase by free text. Matches document titles AND markdown content (case-insensitive substring) and returns a snippet of content around the first match for each hit. Use this to find which document covers a topic, then read it with get_kb_doc.',
      parameters: {
        type: 'object',
        required: ['query'],
        properties: {
          query: {
            type: 'string',
            description: 'Text to search for in document titles and content. Must not be empty.',
          },
        },
      },
    },
    {
      name: 'get_kb_doc',
      description:
        'Read one knowledgebase document in full, including its markdown content. Accepts the document key (e.g. "LDA-KB-1"), its id, or its title (case-insensitive). Use this to read or explain a document the user asks about, or before touching it up.',
      parameters: {
        type: 'object',
        required: ['doc'],
        properties: {
          doc: {
            type: 'string',
            description: 'The document to fetch — its key (e.g. "LDA-KB-1"), its id, or its title (case-insensitive).',
          },
        },
      },
    },
    {
      name: 'list_kb_docs',
      description:
        'List the knowledgebase documents in this project (key and title only, no content). Use this to see what is already documented before answering or creating a new document.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'save_kb_doc',
      description:
        'Create or update ("touch up") a knowledgebase document in this project. This is an UPSERT keyed on title: if a document with the same title already exists (case-insensitive), its content is replaced; otherwise a new document is created. Mermaid diagrams are supported via ```mermaid code blocks. Only write when the user asks you to create, edit, or improve a document. When touching up an existing document, read it first with get_kb_doc and pass the full revised content (content is replaced entirely, not merged).',
      parameters: {
        type: 'object',
        required: ['title', 'content'],
        properties: {
          title: {
            type: 'string',
            description: 'Document title. Used as the upsert key (case-insensitive). Must not be empty.',
          },
          content: {
            type: 'string',
            description: 'Full markdown content. Replaces any existing content entirely.',
          },
        },
      },
    },
  ];
}

export function createKbChatToolHandler(services: Services, projectId: string): ToolHandler {
  // Resolve a doc reference (id, key, or title) within this project.
  function resolveDoc(ref: unknown): KbDocument | undefined {
    if (typeof ref !== 'string' || ref.trim() === '') return undefined;
    const byId = services.kb.get(ref);
    if (byId && byId.project_id === projectId) return byId;
    const byKey = services.kb.getByKey(ref);
    if (byKey && byKey.project_id === projectId) return byKey;
    return services.kb.getByTitle(projectId, ref);
  }

  return async function toolHandler(name: string, args: Record<string, unknown>): Promise<string> {
    if (name === 'search_kb_docs') {
      const query = args['query'];
      if (typeof query !== 'string' || query.trim() === '') {
        return 'Error: query is required';
      }
      const results = services.kb
        .search(projectId, query)
        .map((r) => ({ id: r.id, key: r.key, title: r.title, snippet: r.snippet, updated_at: r.updated_at }));
      return JSON.stringify(results);
    }

    if (name === 'get_kb_doc') {
      const doc = resolveDoc(args['doc']);
      if (!doc) {
        return 'Error: document not found in this project';
      }
      return JSON.stringify(doc);
    }

    if (name === 'list_kb_docs') {
      const docs = services.kb
        .list(projectId)
        .map((d) => ({ id: d.id, key: d.key, title: d.title, updated_at: d.updated_at }));
      return JSON.stringify(docs);
    }

    if (name === 'save_kb_doc') {
      const title = args['title'];
      if (typeof title !== 'string' || title.trim() === '') {
        return 'Error: title is required';
      }
      const content = args['content'];
      if (typeof content !== 'string') {
        return 'Error: content is required';
      }

      // Upsert by case-insensitive title within this project (mirrors ldash_save_kb_doc).
      const existing = services.kb.getByTitle(projectId, title.trim());
      if (existing) {
        const doc = services.kb.update(existing.id, { title: title.trim(), content }, KB_CHAT_ACTOR);
        return JSON.stringify({ success: true, action: 'updated', id: doc.id, key: doc.key, title: doc.title });
      }

      const doc = services.kb.create({ project_id: projectId, title: title.trim(), content }, KB_CHAT_ACTOR);
      return JSON.stringify({ success: true, action: 'created', id: doc.id, key: doc.key, title: doc.title });
    }

    return 'Error: unknown tool ' + name;
  };
}
