---
"@cotal-ai/cli": patch
---

Keep self-updates of installed POSIX CLIs in the prefix owning the invoked package and bin link, including when bypassing the installer launcher with a vendored Node runtime. Refuse conflicting or incomplete global layouts before installation, and preserve separate global updates from local/npx copies and source checkouts.
