# Documentation content

This private build package reads the canonical pages for the website and the connector's release bundle.
It uses Fumadocs Markdown processing without Next.js, React, or a website build.
The installed connector serves the generated Markdown and does not import this package.

```js
import { readDocument, discoverDocuments } from '@cotal-ai/docs-content';

for (const path of await discoverDocuments('docs')) {
  const doc = await readDocument(path);
  console.log(doc.metadata.title, doc.markdown);
}
```

Ordinary `.md` pages retain their Markdown body.
Their H1 and first paragraph provide the title and description.
Direct `.mdx` pages use `title`, `description`, `kind`, and `audience` frontmatter.
The title provides the page's H1, so the authored body starts below that heading.
Classification and audience are metadata, not opening blockquotes.
A directory cannot contain both `.md` and `.mdx` files with the same basename.

Import supported components by their original names from Fumadocs UI:

| Module | Components | Markdown export |
| --- | --- | --- |
| `fumadocs-ui/components/card` | `Cards`, `Card` | Linked title or an unlinked group title, with the complete body. |
| `fumadocs-ui/components/steps` | `Steps`, `Step` | All authored headings, instructions, and code. |
| `fumadocs-ui/components/tabs` | `Tabs`, `Tab` | Every tab label and body, including inactive tabs. |
| `fumadocs-ui/components/callout` | `Callout` | Warning type, optional title, and complete body in a blockquote. |

Use string props for card `title`, optional `href`, tab `value`, and callout `type` and `title`.
Tabs also support a static string array in `items`, an integer `defaultIndex`, a string `groupId`, and a boolean `persist`.
Each `items` entry must match its `Tab` value in order.
Code fences use Fumadocs' native code-block copy control and export unchanged.

The exporter rejects unknown components, unsupported attributes, import aliases, executable exports, spreads, and dynamic expressions.
Add an explicit semantic conversion and its content-preservation test before introducing another component.
This prevents website components from dropping instructions in downloads or `cotal_docs`.

The `fumadocs-core` version is pinned because the build uses the plugin's internal `_data` option to read Markdown without evaluating compiled MDX.
Run the export tests before upgrading that dependency.

Root builds install this package through pnpm's workspace dependency.
The standalone website installs its own copy with npm's `file:` dependency and `install-links=true`.
Neither build resolves dependencies through the other installation.

```sh
pnpm --filter @cotal-ai/docs-content typecheck
pnpm --filter @cotal-ai/docs-content test
```
## Generated MDX

`markdownToMdx` from `@cotal-ai/docs-content/generate` serializes generated Markdown with the native remark MDX writer.
HTML-shaped placeholders remain literal text. Code, tables, and links retain their Markdown meaning.
The generator module is separate from `readDocument` and imports no website framework.
