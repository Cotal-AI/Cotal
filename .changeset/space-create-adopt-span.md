---
"@cotal-ai/cli": patch
---

On a terminal, `space create` in a moved or copied folder that holds another folder's stack journal
names its adopt command in backticks, as `status` there does, so a wrapped line keeps the command
whole. Before, at 80 columns, the quoted `--root` path started on the next line, and at 40 columns
it was split inside its quotes.
