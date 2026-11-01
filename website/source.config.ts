import { defineDocs, defineConfig } from 'fumadocs-mdx/config';
import { pageSchema } from 'fumadocs-core/source/schema';
import { z } from 'zod';
import { remarkMdxMermaid } from 'fumadocs-core/mdx-plugins';

export const docs = defineDocs({
  dir: 'content',
  docs: {
    schema: pageSchema.extend({
      kind: z.string().optional(),
      audience: z.string().optional(),
    }),
  },
});
export default defineConfig({ mdxOptions: { remarkPlugins: [remarkMdxMermaid] } });
