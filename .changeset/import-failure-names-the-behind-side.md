---
"@cotal-ai/workspace": patch
---

Name which install is behind when an extension fails to import a missing `@cotal-ai/*` export. The
error used to prescribe `cotal ext add <extension>` for every import failure, which reinstalls
whichever side is current: when the linked core is the older one, no reinstall of the extension can
supply the export, so the prescribed command changes nothing. It now names the missing symbol, the
peer copy that was actually linked with its version and path, and the side that is behind — pointing
at the install that owns that copy when the core is older or the same version but an older build,
keeping the `cotal ext add` remedy only when the extension is the older side, and refusing to name a
side at all when the two cannot be ranked.
