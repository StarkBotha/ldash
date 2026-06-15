import type { Services } from '../types.js';

export function buildKbChatContext(services: Services, projectId: string): string {
  const project = services.projects.get(projectId);
  if (!project) {
    throw new Error('Project not found: ' + projectId);
  }

  const docs = services.kb.list(projectId);
  let docsSection: string;
  if (docs.length === 0) {
    docsSection = '(the knowledgebase is currently empty — there are no documents yet)';
  } else {
    docsSection = docs.map((d) => `  - ${d.key} — ${d.title}`).join('\n');
  }

  return `You are a helpful assistant for the knowledgebase of the software project "${project.name}". The knowledgebase is a set of markdown documents holding project knowledge: architecture overviews, how-tos, runbooks, hosting and deployment info, gotchas, and diagrams (mermaid code blocks render in the UI). You are scoped to THIS project's knowledgebase only.

CURRENT DOCUMENTS (${docs.length}):
${docsSection}

TOOLS:
- search_kb_docs — full-text search over titles and content; returns snippets. Use it to find which document covers a topic.
- get_kb_doc — read one document in full (by key, id, or title). Use it before explaining or editing a document.
- list_kb_docs — list every document (key + title).
- save_kb_doc — create a new document or update ("touch up") an existing one. Upserts by title. Content is replaced entirely, so when touching up an existing document, read it first and pass the full revised markdown.

INSTRUCTIONS:
- Help the user find information across the knowledgebase, explain what a document covers, and create or improve documents when asked.
- Always ground answers in the actual documents — search or read before answering rather than guessing. Cite documents by their key (e.g. "LDA-KB-1").
- Only write (save_kb_doc) when the user asks you to create, edit, or improve a document. Do not modify documents the user did not ask about.
- Keep responses concise.`;
}

export function buildItemChatContext(services: Services, itemId: string): string {
  const item = services.items.get(itemId);
  if (!item) {
    throw new Error('Item not found: ' + itemId);
  }

  const columns = services.columns.list();
  const columnMap = new Map<string, string>(columns.map((c) => [c.id, c.name]));
  const columnName = columnMap.get(item.column_id) ?? item.column_id;

  // Parent item
  let parentSection = '';
  if (item.parent_id) {
    const parent = services.items.get(item.parent_id);
    if (parent) {
      const parentColumnName = columnMap.get(parent.column_id) ?? parent.column_id;
      parentSection = `\nPARENT ITEM:\n  Title: ${parent.title}\n  Type: ${parent.type}\n  Status: ${parentColumnName}\n`;
    }
  }

  // Children (up to 10)
  const allChildren = services.items.listFiltered({
    project_id: item.project_id,
    parent_id: itemId,
  });
  const children = allChildren.slice(0, 10);
  let childrenSection = '';
  if (children.length > 0) {
    const childLines = children
      .map((c) => `  - [${c.type}] ${c.key} ${c.title} (status: ${columnMap.get(c.column_id) ?? c.column_id})`)
      .join('\n');
    childrenSection = `\nCHILD ITEMS (${children.length}):\n${childLines}\n`;
  }

  // Comments (last 10)
  const allComments = services.comments.listByItem(itemId);
  const comments = allComments.slice(-10);
  let commentsSection = '';
  if (comments.length > 0) {
    const commentLines = comments
      .map((c) => `  [${c.author} at ${c.created_at}] ${c.body}`)
      .join('\n');
    commentsSection = `\nRECENT COMMENTS (last ${comments.length}):\n${commentLines}\n`;
  }

  // Activity (last 20, reversed to chronological order)
  const activityDesc = services.activity.listByItem(itemId, { limit: 20 });
  const activity = [...activityDesc].reverse();
  let activitySection = '';
  if (activity.length > 0) {
    const activityLines = activity
      .map((e) => `  [${e.created_at}] ${e.event_type} — ${JSON.stringify(e.payload)}`)
      .join('\n');
    activitySection = `\nRECENT ACTIVITY (last ${activity.length} entries):\n${activityLines}\n`;
  }

  const blockedText = item.blocked
    ? `Yes — ${item.blocked_reason}`
    : 'No';

  const descriptionText = item.description && item.description.trim() !== ''
    ? item.description
    : '(no description)';

  return `You are a helpful assistant for a software project planning board. You are currently helping with a specific item. Below is the context for that item.

ITEM:
  Key: ${item.key}
  Id: ${item.id}
  Title: ${item.title}
  Type: ${item.type}
  Status: ${columnName}
  Description: ${descriptionText}
  Flagged: ${item.flagged ? 'Yes' : 'No'}
  Blocked: ${blockedText}
${parentSection}${childrenSection}${commentsSection}${activitySection}
INSTRUCTIONS:
- Answer questions about this item, its context, and what work it involves.
- You may suggest approaches, identify risks, or help break down the work.
- You may act on the board with the provided tools when the user asks for it (move tasks, comment, file follow-up work). Refer to items by their Id or Key shown above — never by title.
- Keep responses concise and actionable.`;
}
