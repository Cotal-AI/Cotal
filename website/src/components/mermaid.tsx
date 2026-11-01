'use client';

import { useEffect, useId, useState } from 'react';
import { useTheme } from 'next-themes';

type Diagram = { kind: 'loading' } | { kind: 'ready'; svg: string } | { kind: 'error'; error: Error };
let renderer: Promise<typeof import('mermaid')> | undefined;

export function Mermaid({ chart }: { chart: string }) {
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const { resolvedTheme } = useTheme();
  const theme = resolvedTheme === 'dark' ? 'dark' : 'default';
  const [diagram, setDiagram] = useState<Diagram>({ kind: 'loading' });
  useEffect(() => {
    let active = true;
    setDiagram({ kind: 'loading' });
    async function render() {
      const { default: mermaid } = await (renderer ??= import('mermaid'));
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', fontFamily: 'inherit', theme });
      const { svg } = await mermaid.render(id, chart);
      if (active) setDiagram({ kind: 'ready', svg });
    }
    void render().catch(error => {
      if (active) setDiagram({ kind: 'error', error: error instanceof Error ? error : new Error(String(error)) });
    });
    return () => { active = false; };
  }, [chart, id, theme]);
  if (diagram.kind === 'error') throw diagram.error;
  return (
    <div className="my-6 overflow-x-auto [&_svg]:mx-auto" aria-busy={diagram.kind === 'loading'}>
      {diagram.kind === 'ready'
        ? <div dangerouslySetInnerHTML={{ __html: diagram.svg }} />
        : <span className="text-sm text-fd-muted-foreground">Rendering diagram...</span>}
    </div>
  );
}
