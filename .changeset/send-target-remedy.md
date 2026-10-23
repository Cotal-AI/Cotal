---
"@cotal-ai/cli": patch
---

`cotal send` now says what to do when its target or a mention cannot be resolved. A name that several participants share is refused with the full identities that carry it, and one that is not present points at `cotal who --all`. Both reach `error.remedy` and the human "Next" line.
