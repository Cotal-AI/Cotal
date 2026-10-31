---
"@cotal-ai/core": patch
---

`newAmendmentId` no longer slices its id to 43 characters. 32 random bytes always encode to exactly 43 base64url characters, so the slice never removed anything, and it read as a truncation the id depended on. The doc comment and SPEC now say the length outright. Ids are unchanged.
