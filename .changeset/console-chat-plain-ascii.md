---
"@cotal-ai/cli": patch
---

`cotal console --plain` and `cotal chat --plain` now write their lines in ASCII, as every plain report does: no status marks, and `·`, `…` and `→` as `-`, `...` and `->`. They drew the marks and punctuation under any locale. The console line stream that a pipe gets does the same under a locale that is not UTF-8, as `LC_ALL`, then `LC_CTYPE`, then `LANG` decide.
