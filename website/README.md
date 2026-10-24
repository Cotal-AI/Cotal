# Cotal docs site

Astro [Starlight](https://starlight.astro.build/) site for Cotal's documentation,
built to be **agent-native** — the docs a protocol for agents ships should be
readable by agents.

The canonical Markdown stays in [`/docs`](../docs) and [`/SPEC.md`](../SPEC.md);
this site renders it. `scripts/sync-docs.mjs` derives a frontmatter title from the H1
each file opens with and a description from its first paragraph of text after the banner
and any headings, and rewrites `*.md` cross-links and image paths to site routes, whether
a Markdown link or an HTML or JSX `href`, `src` or `srcset` names them, then writes the
result into `src/content/docs/` (git-ignored). A page that does not open with an H1, a
page with no such paragraph, one whose long paragraph opens with a character too long
to shorten, or a link whose `#anchor` names no heading or `<a id>` on a published page,
fails the sync. Edit the source files, not the generated copies.

## Develop

```sh
npm ci                           # install the locked website dependencies
npm run dev                      # syncs docs, then starts Astro
npm run build                    # syncs docs, then builds to dist/
```

`astro.config.mjs` loads the sidebar the sync generates and stops with an error when it
cannot read or parse that file, so run `npm run sync` before calling `npm run astro`
directly.

## Dashboard HTTP reference

`starlight-openapi` renders the seven dashboard read operations from
`implementations/web/openapi.json`. Edit that description and run `npm run gen:api`
to update `docs/dashboard-api.md`. The build refuses stale generated Markdown.
Wire message and presence schemas come from `spec/cotal.schema.json`.

The sync publishes the bundled contract at `/dashboard.openapi.json`. Each plugin
page under `/api/dashboard/` has a Markdown twin. The generated Markdown source feeds the existing llms indexes and connector docs
bundle. It is served at `/api/dashboard.md` and has no second HTML reference;
`/dashboard-api/` redirects to `/api/dashboard/`.
`npm test` checks reference generation; the build checks the published artifacts.
After building packages, run `pnpm smoke:web-openapi` from the repository root for
HTTP and SSE conformance against a private broker.

## Agent-native surface

Every feature below is generated at build time, served at the edge, or drift-guarded
by `scripts/check-dist.mjs`.

| Endpoint | Source |
| --- | --- |
| `/llms.txt`, `/llms-full.txt`, `/llms-small.txt` | [`starlight-llms-txt`](https://github.com/delucis/starlight-llms-txt) plugin |
| `/<page>.md` (raw Markdown per page) | `src/pages/[...slug].md.ts` |
| `<link rel="alternate" type="text/markdown">` in each page head | `src/components/Head.astro` |
| `Accept: text/markdown` on a canonical URL → Markdown + `x-markdown-tokens` (on `/` it returns the `/llms.txt` index) | `functions/_middleware.ts` (Cloudflare Pages) |
| `Link` headers on the homepage (`service-doc`, `describedby`; RFC 8288) | `functions/_middleware.ts` |
| `/robots.txt` (wildcard crawl rules, Content Signals, sitemap pointer) | `public/robots.txt` |
| `/install.sh`, and the root of `get.cotal.ai` / `install.cotal.ai`, served as `text/plain` so it reads in a browser | `/install.sh` at the repo root, copied by `scripts/sync-docs.mjs`; host routing in `functions/_middleware.ts` |
| `/.well-known/agent-skills/` (Agent Skills + discovery index with sha256 digests) | `public/.well-known/agent-skills/` + `scripts/sync-docs.mjs` |
| `/docs-for-agents` (human/agent-readable guide to the above) | `src/content/docs/docs-for-agents.mdx` |

Verify locally against the real Pages runtime:

```sh
npm run build
npx wrangler pages dev
curl -H "Accept: text/markdown" http://127.0.0.1:8788/spec/   # -> Markdown
curl http://127.0.0.1:8788/spec.md                            # -> Markdown
curl http://127.0.0.1:8788/llms.txt                           # -> index
```

## Deploy (Cloudflare Pages)

- **Root directory:** `website`
- **Build command:** `npm run build`
- **Output directory:** `dist`
- **Install command:** `npm ci`

`functions/` (the `Accept` negotiation) and `public/_routes.json` (which limits the
function to page routes, keeping it off static assets) are picked up automatically.
Set `site` in `astro.config.mjs` to the production origin so `llms.txt` links and the
sitemap are absolute.

## Not yet built: docs MCP server

The top tier of agent-native — letting an agent query these docs as a *tool* rather
than fetching files — is a separate remote MCP server (a Cloudflare Worker). It would
read `llms-full.txt` / the per-page `.md` and expose `search_docs` / `get_page`
tools. Tracked as a follow-up.
