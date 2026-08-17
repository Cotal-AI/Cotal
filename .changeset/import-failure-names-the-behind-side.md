---
"@cotal-ai/workspace": patch
---

Name which install is behind when an extension fails to import a missing `@cotal-ai/*` export. The
error used to prescribe `cotal ext add <extension>` for every import failure, which reinstalls
whichever side is current: when the linked core is the older one, no reinstall of the extension can
supply the export, so the prescribed command changes nothing. It now names the missing symbol, the
peer copy that was actually linked (with its version and path), and the side that is behind. When the
core is behind, or is the same version but an older build, it prescribes an exact command for the
copy it just named: a pinned `npm i -g cotal-ai@<version>` for an installed copy, or a rebuild for a
source checkout, where that command would be wrong. It keeps the `cotal ext add` remedy only when the
extension is the older side, and refuses to name a side at all when the two cannot be ranked.
