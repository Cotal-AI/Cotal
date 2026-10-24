---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

`cotal sync` no longer refuses a space catalog row that has no registration as "the user-auth bundle is not JSON - export it where the mesh runs and pass the file unmodified". No file is involved there, so the row is now refused as "the user-auth bundle must be a JSON object". The workspace package exports `checkBundleDocument`, the bundle check for a value the caller already holds, and the catalog check and the enrollment bundle check in `cotal spawn` call it directly instead of serializing the value for `checkUserBundle`.
