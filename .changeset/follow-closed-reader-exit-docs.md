---
"cotal-ai": patch
---

The CLI reference now says that Ctrl-C ends `watch`, `history --follow`, `console` and
`channel members --follow` with exit 130 after their reader closed, as they do, instead of naming
exit 0 for the last three.
