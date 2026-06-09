import type { Services } from '../types.js';

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
      .map((c) => `  - [${c.type}] ${c.title} (status: ${columnMap.get(c.column_id) ?? c.column_id})`)
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
- Do not create, delete, or modify board items — you are in read-only chat mode.
- Keep responses concise and actionable.`;
}
