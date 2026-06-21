import type { ReactNode } from 'react';

// Escapes a string for safe literal use inside a RegExp
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface Props {
  text: string;
  // The current project's name + key prefix. When either is missing (e.g. the
  // project query hasn't resolved yet) the text renders plain, with no links.
  projectName?: string;
  prefix?: string;
}

// Renders plain text, turning this project's KB-article keys (e.g. LDA-KB-12)
// into links that open the article in a new tab. Only KB keys are matched —
// board item keys like LDA-12 (no "-KB-") are left as plain text. Matching is
// scoped to the current project's prefix so a key always points at the right KB.
export function KbLinkedText({ text, projectName, prefix }: Props) {
  if (!projectName || !prefix) return <>{text}</>;

  const re = new RegExp(`\\b${escapeRegExp(prefix)}-KB-\\d+\\b`, 'g');
  const parts: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const key = m[0];
    const href = `/projects/${encodeURIComponent(projectName)}/kb/${encodeURIComponent(
      key.toLowerCase()
    )}`;
    parts.push(
      <a
        key={`${m.index}-${key}`}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        style={{ color: 'var(--link)', textDecoration: 'underline' }}
      >
        {key}
      </a>
    );
    last = m.index + key.length;
  }
  if (last < text.length) parts.push(text.slice(last));

  return <>{parts}</>;
}
