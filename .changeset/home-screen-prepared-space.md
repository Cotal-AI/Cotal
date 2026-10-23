---
"@cotal-ai/cli": patch
---

Bare `cotal` now offers `cotal up` first for a prepared space that has not started. Before, it offered
`cotal spawn` for a selected prepared space, which refuses until the space runs. With nothing
selected, it also names the space prepared in the current folder, including right after `down`
there, rather than saying no space is selected and offering `cotal setup`. With no agent application,
`status` Next no longer says setup prepares a space when one is running or prepared, and on a
running space it still lists `ps` and `use`.
