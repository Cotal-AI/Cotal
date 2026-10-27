---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

A catalog row and an enrollment bundle already hold their user-auth registration as a value, so both are checked with the object check instead of `JSON.stringify` and the text validator. A row with no registration is refused as a bundle that is not an object. `checkUserBundle` still parses exported text and keeps the not-JSON sentence for a file that does not parse.
