---
"@cotal-ai/core": minor
---

Stop publishing the raw attachment-index mutators as public API.

The attachment index is writable only through `confirmAttach`, which checks that the caller possesses
the blob under its own live lifecycle before it writes a row. A blanket `export *` from
`artifact-index.js` put the raw helpers `putAttachmentIfAbsent` and `deleteAttachment` on the package's
public surface, so a consumer could `import { deleteAttachment } from "@cotal-ai/core"` and write the
index directly — no succession fence, no possession check.

The guard for that invariant is a structural sweep over this repository, and an out-of-tree caller is
outside its universe by construction: the sweep reported the invariant holding the whole time it was
false for anyone outside the tree. The export list is where the invariant has to hold, so the module's
reads and key grammar stay public and the two mutators do not.

The suite now asserts their absence from the runtime surface rather than from the text of `index.ts`,
since a re-export can arrive by a route that greps of one file would miss.
