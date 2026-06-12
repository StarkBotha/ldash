import { useEffect, useState } from 'react';

interface Props {
  code: string;
}

// mermaid.initialize must only run once per page
let initialized = false;
let renderSeq = 0;

/**
 * Renders a ```mermaid code fence as an actual diagram. The mermaid library
 * is heavy, so it's dynamically imported on first use. On parse/render
 * failure we fall back to the raw code block plus a small error note.
 */
export function Mermaid({ code }: Props) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setError(null);

    (async () => {
      // Unique id per render — mermaid.render requires one and reuses break it
      const id = `kb-mermaid-${++renderSeq}`;
      try {
        const mermaid = (await import('mermaid')).default;
        if (!initialized) {
          // 'neutral' matches the app's light gray look
          mermaid.initialize({ startOnLoad: false, theme: 'neutral' });
          initialized = true;
        }
        const result = await mermaid.render(id, code);
        if (!cancelled) setSvg(result.svg);
      } catch (err) {
        // mermaid can leave a dangling temp element behind on failure
        document.getElementById(id)?.remove();
        document.getElementById(`d${id}`)?.remove();
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [code]);

  if (error !== null) {
    return (
      <div className="kb-mermaid-error">
        <pre>
          <code>{code}</code>
        </pre>
        <div className="kb-mermaid-error-note">Mermaid diagram failed to render: {error}</div>
      </div>
    );
  }

  if (svg === null) {
    return <div className="kb-mermaid kb-mermaid-loading">Rendering diagram…</div>;
  }

  // Safe to inject: mermaid runs with its default securityLevel 'strict',
  // which sanitizes labels/links in the SVG it generates, and the source is
  // the user's own local documents.
  return <div className="kb-mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
}
