---
"cotal-ai": patch
---

`cotal docs <page>` on a terminal draws the page for reading. Each heading is a title, paragraphs and
lists wrap to the terminal, a table is text that becomes one record per row when its columns do not
fit, and a code block keeps its lines. On an 80-column terminal `docs cli` now fits 80 columns,
except a line that is one word. To a pipe or a file, and with `--plain` or `--json`, the page stays
Markdown.
