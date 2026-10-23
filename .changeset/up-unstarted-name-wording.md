---
"@cotal-ai/cli": patch
---

When `up` refuses a space before any member starts, as it does for an earlier release's record whose
name is not a routing token, it says that no member was started instead of that started members were
kept, and its next step quotes a space name that holds a space or other shell character.
