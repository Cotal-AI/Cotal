---
"@cotal-ai/workspace": patch
---

Report a project's unusable trust folder truthfully. A readable account record in a project folder's
`.cotal/auth` that will not load, such as an `auth.json` that is not JSON, made a command that would
target that folder refuse with `TARGET_AMBIGUOUS` and the empty message `multiple meshes running: `,
with no mesh running. It now refuses with `DEPENDENCY_UNAVAILABLE`, names each such record by path,
and says to repair or remove it or to name a space with `--space <name>`. This includes the
`--server` path. A `.cotal/auth` that lists its files but cannot be searched, such as one at mode
0600, refused the same empty way and is now refused as a folder this account cannot read. When this
account cannot enter a folder on the way to `.cotal/auth`, such as the project's `.cotal`, the next
step now names that folder instead of saying to make `.cotal/auth` readable. Several valid account records, explicit `--space`, a selected space, and missing or
readable projects are unchanged, and no record or mode is changed.
