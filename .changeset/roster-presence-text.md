---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/cli": patch
---

`cotal_roster`, `cotal ps`, `cotal status`, `cotal endpoints`, `cotal console` and `cotal join` print each peer's condition code and activity on one line and at most 200 characters. A control character or Unicode line separator shows as a `\uXXXX` escape, so a peer can no longer split its row into what reads as a second roster entry, pass terminal control bytes through, or flood every row with a 4000-character activity. The rule is `presenceText` in `@cotal-ai/core`, and `oneLine` moved there from `@cotal-ai/workspace`, which still re-exports it.
