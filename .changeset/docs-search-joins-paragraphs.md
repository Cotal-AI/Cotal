---
"cotal-ai": patch
---

`cotal docs --search` on a terminal now draws each hit as `cotal docs <page>` draws its page: a paragraph is joined before it wraps, so a span in backticks that crosses a line break in the page's source stays whole, and lines are no longer ragged. A code block keeps its lines without its fence marks, a list item or table keeps its own lines, and the hit's heading is its title. `--plain` wraps the same text. At 80 columns `cotal docs --search manager` broke `` `cotal service show manager` `` after `cotal`, at 120 columns too.
