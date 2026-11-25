---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

Quote the suggested `auth mint --out` path when a symbolic link blocks credential output, so paths with spaces or other shell characters can be pasted as one argument.
Keep the quoted argument together on narrow terminals, and omit the example when terminal escaping would change the path.
