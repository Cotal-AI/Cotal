# Cotal docs site

Next.js and Fumadocs render the authored Markdown and MDX in `/docs` and `/SPEC.md`.
Edit those sources rather than the generated collection under `website/content/`.
The sync script publishes navigation, links, Markdown downloads, redirects, and
agent discovery files. `@cotal-ai/docs-content` provides the same complete Markdown
to this site and the release bundle served by `cotal_docs`.

## Develop

Requires Node.js 22 or later.

```sh
cd website
npm ci
npm run dev
npm run typecheck
npm run build
npm run preview
# In another terminal while preview runs:
npm run check:runtime
```

Run the content-generating commands sequentially. The build exports static HTML
to `dist/`. Search runs in the browser against a build-time index.
There is no Next.js server in production.

## Navigation

The site uses the standard Fumadocs Docs layout with the Neutral theme and
Cotal gold accents. Sidebar page links each occupy their own row. Desktop
section tabs sit above the page; mobile uses the section dropdown.

Docs live at `/docs/<page>/`; API Reference lives at `/api-reference/<page>/`.
The root opens What is Cotal through a Pages redirect. Old page and Markdown
URLs redirect to their new section. Changelog will be added later.

The navigation tree in `scripts/sync-docs.mjs` controls publication and order.
Its published page set must match `docs/README.md`. Guides and Concepts contain
collapsible subsections. A page has one navigation home, and its subsection does
not change its URL.

Start here uses direct MDX with explicit Fumadocs Cards, Steps, and Callout
components. Titles, descriptions, classification, and audience live in frontmatter.
Tutorial headings declare their existing IDs so incoming fragment links still work.
Fumadocs code blocks provide the setup prompt's copy button.

Reviewed pages use direct MDX. Project pages await their writing pass.
The normative specification remains Markdown, and the MCP catalog is generated MDX.

The shared build package converts supported components to complete Markdown.
Card links and descriptions, all tab alternatives, warnings, and code remain in
the downloads. Unknown components and executable expressions fail the export.
See [`tools/docs-content/README.md`](../tools/docs-content/README.md) for the authoring contract.

The website installs its own copy of the shared package through a local file
dependency. `install-links=true` in `.npmrc` makes that copy resolve dependencies
inside the website installation. The connector build uses the root pnpm workspace
and does not need Next.js or the website's dependencies.

## Agent endpoints

The build preserves `/llms.txt`, `/llms-full.txt`, `/llms-small.txt`, `/prompt.md`,
`/cotal.schema.json`, `/install.sh`, and `/.well-known/agent-skills/`.
Each page advertises its `.md` twin in its HTML head. Pages middleware serves
that twin for `Accept: text/markdown` with an `x-markdown-tokens` estimate.
The root returns the documentation index for Markdown requests and discovery
Link headers. Installer hosts `get.cotal.ai` and `install.cotal.ai` serve the installer.

## Deployment

Cloudflare Pages uses root directory `website`, build command `npm run build`,
output directory `dist`, and install command `npm ci`.
The existing workflow publishes PR previews, production, and release snapshots.
`functions/` provides content negotiation. The Next.js development server does
not run Pages middleware or redirects; use the Pages preview for compatibility checks.

Build checks verify installer safety, skill digests, page exports, legacy redirects,
and local links and assets. Existing unresolved fragment links await page cleanup.
Verify a preview deployment before production cutover.
