import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { Blocks, BookOpen } from 'lucide-react';
import { source } from '@/lib/source';

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <DocsLayout
      tree={source.getPageTree()}
      sidebar={{ collapsible: false }}
      containerProps={{
        style: {
          gridTemplateColumns: '0px var(--fd-sidebar-col) minmax(0, 1fr) var(--fd-toc-width) max(0px, calc((100% - var(--fd-layout-width, 97rem)) / 2))',
        },
      }}
      tabMode="top"
      tabs={[
        {
          title: <span className="cotal-layout-tab"><BookOpen size={16} strokeWidth={1.75} aria-hidden="true" />Docs</span>,
          url: '/docs/what-is-cotal/',
          urls: new Set(source.getPages().filter(page => page.slugs[0] === 'docs').map(page => page.url)),
        },
        {
          title: <span className="cotal-layout-tab"><Blocks size={16} strokeWidth={1.75} aria-hidden="true" />API Reference</span>,
          url: '/api-reference/overview/',
          urls: new Set(source.getPages().filter(page => page.slugs[0] === 'api-reference').map(page => page.url)),
        },
      ]}
      nav={{
        title: <><img src="/favicon.svg" width="24" height="24" alt="" /> Cotal</>,
        url: '/docs/what-is-cotal/',
      }}
      githubUrl="https://github.com/Cotal-AI/Cotal"
    >
      {children}
    </DocsLayout>
  );
}
