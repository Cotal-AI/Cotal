---
"@cotal-ai/workspace": patch
---

A provenance line (`→ using`, `→ wrote`, `→ removed`) is always one line. A control character or Unicode line separator in the announced name or path is printed as a `\uXXXX` escape, so a newline in a path such as `HOME` can no longer split one announcement into a second line the command never wrote, and a carriage return can no longer overwrite it on a terminal. The stdout line printed when stderr fails follows the same rule.
