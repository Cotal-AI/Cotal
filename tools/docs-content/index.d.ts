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
