---
"@cotal-ai/workspace": patch
---

On a terminal, the source a `→ using`, `→ wrote` or `→ removed` line names now wraps as one word, however many spaces it holds. A path such as `<root>/proj/with space/.cotal/agents/default.md` that does not fit after the label goes whole on the line under it, wider than the line if it must be. It used to be split at its spaces, so no line held the whole path to copy. The label still wraps at its spaces, and written to a pipe or a file the line is unchanged.
