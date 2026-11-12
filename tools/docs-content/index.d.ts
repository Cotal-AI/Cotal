export interface Document {
  sourcePath: string;
  format: 'md' | 'mdx';
  metadata: {
    title: string;
    description: string;
    kind: string;
    audience?: string;
  };
  content: string;
  markdown: string;
}
export function readDocument(sourcePath: string): Promise<Document>;
export function discoverDocuments(directory: string): Promise<string[]>;
export function documentationCategory(kind: string, sourcePath: string): string;
export { frontmatter } from 'fumadocs-core/content/md/frontmatter';
