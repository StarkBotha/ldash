import { useState } from 'react';
import { useComments, useCreateComment } from '../hooks/useItemDetail';
import type { Comment } from '../types';

interface Props {
  itemId: string;
}

export function CommentBox({ itemId }: Props) {
  const { data: comments } = useComments(itemId);
  const createComment = useCreateComment();
  const [body, setBody] = useState('');
  const [error, setError] = useState('');

  async function handlePost() {
    if (!body.trim()) return;
    setError('');
    try {
      await createComment.mutateAsync({ item_id: itemId, body: body.trim() });
      setBody('');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
        {(comments ?? []).map((c: Comment) => (
          <div key={c.id} style={{ background: '#f9f9f9', borderRadius: 6, padding: 10, fontSize: 15 }}>
            <div style={{ fontSize: 13, color: '#888', marginBottom: 4 }}>
              {c.author} · {new Date(c.created_at).toLocaleString()}
            </div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{c.body}</div>
          </div>
        ))}
      </div>

      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Add a comment…"
        rows={3}
        style={{ width: '100%', padding: 8, boxSizing: 'border-box', resize: 'vertical' }}
      />
      {error && <p style={{ color: 'red', fontSize: 14 }}>{error}</p>}
      <button
        onClick={handlePost}
        disabled={!body.trim() || createComment.isPending}
        style={{ marginTop: 6 }}
      >
        Post
      </button>
    </div>
  );
}
