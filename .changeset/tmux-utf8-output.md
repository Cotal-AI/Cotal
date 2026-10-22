---
"@cotal-ai/tmux": patch
---

The tmux runtime passes `-u` to every tmux call. Without a UTF-8 locale (`LANG`, `LC_CTYPE` and `LC_ALL` unset or not UTF-8) the tmux client wrote tabs and non-ASCII bytes in its output as `_`, so the runtime could not find a window by name and read pane screens with mangled text.
