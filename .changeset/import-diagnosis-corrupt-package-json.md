---
"@cotal-ai/workspace": patch
---

A missing-export import failure no longer drops an extension's declared `@cotal-ai/*` peer range when its `package.json` is corrupt or unreadable at diagnosis time. Before, the unreadable file was read as declaring no range, so `cotal ext add` or a later load ranked the pair without the floor (for a third-party package, "neither side can be named as behind ... is not a @cotal-ai/* package") and never mentioned the damaged file. The error now names that `package.json` by path, keeps the original import error, claims no ranking, and ends with the reinstall remedy.
