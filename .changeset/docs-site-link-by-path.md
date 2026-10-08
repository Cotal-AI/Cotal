---
"@cotal-ai/connector-core": patch
---

The docs site sync now resolves a relative link by its repository path. A link from a published page to a design note that shares a name with a published page, such as `design/release.md`, used to land on that page (`/release/`) even when the note did not exist. It now goes to the note on GitHub, and a link to a missing file fails the sync and names it. The pages that linked design notes through hard-coded GitHub URLs now link them relatively, so `pnpm check:docs-site` catches a renamed or deleted note. The sync also reads the Quickstart as MDX, as the site renders it, so its indented links are checked and link-shaped text in its MDX JavaScript (imports and exports, expressions, JSX tags) is kept as written. The `cotal_docs` pages carry the relative design-note links. No runtime change.
