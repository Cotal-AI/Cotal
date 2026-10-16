---
"cotal-ai": patch
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

Terminal output reads cleanly at any width.

- On a terminal, long report values and lines, warnings and failures wrap at spaces, each continuation line under the text it continues; a word wider than the line, such as a path, is never split. Output to a pipe or a file is not wrapped.
- Help, the command list and the entry screen wrap the same way. A usage line breaks only between options, and when the flag names leave their descriptions fewer than 30 columns, each description goes on the lines under its flag.
- `--plain` writes punctuation in ASCII: `·` and long dashes as `-`, `…` as `...`, `→` and `↳` as `->`, and `§` as `section`. A partial result's line starts with `!`.
- `cotal completion` fills every cell: a shell with no install line says `not wired in`, and PowerShell's file says `none`.
- The help for `--on` and `ps --slots` says what they do in plain words.
