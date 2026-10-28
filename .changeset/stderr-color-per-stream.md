---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"@cotal-ai/auth": patch
"@cotal-ai/manager": patch
"@cotal-ai/runtime": patch
"cotal-ai": patch
---

Redirecting stderr no longer leaves ANSI color in the file. Color under `auto` was decided by stdout alone, so `cotal spawn 2>err.txt` on a terminal wrote `Mesh:` headings and `✗` refusals to `err.txt` with their color codes, and `cotal spawn >out.txt` left the refusal on the terminal uncolored. Each stream is now colored only when it is a terminal, so a pipe or redirect of either stream is plain text. Reports, help, warnings and failure reports take their color from the stream they are written to, as do most error lines. Some other lines a command writes directly, such as progress notes, are colored only when stdout and stderr are both terminals. `always`, `never`, `--no-color`, `NO_COLOR`, `FORCE_COLOR` and `TERM=dumb` keep their meaning for both streams.
