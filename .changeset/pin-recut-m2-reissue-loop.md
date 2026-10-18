---
"@cotal-ai/manager": patch
---

The pin-recut mutation fixture's second mutation targets the re-issue inside the bounded loop. It still named the single re-issue the loop replaced, so the mutation runner refused it as not found and the instance-pin smoke's re-issue cell had no mutation behind it. It now breaks out of the loop before the re-issue and is measured killed on that cell. No behavior changes.
