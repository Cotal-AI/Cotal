---
"@cotal-ai/cli": patch
---

`cotal personas list` prints the YAML diagnostic of an unparseable persona as lines: the reason, then the excerpt with a caret under the fault. It printed them on one line, with each line break shown as `\u000a`.
