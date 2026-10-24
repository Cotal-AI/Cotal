---
"@cotal-ai/cli": patch
---

The `✗` line of a usage refusal now shows control characters as escapes, as the classified report
already did. A `.cotal/channels.json` or `--channels` file that is not valid JSON is refused with the
parser's excerpt of the file, and an escape sequence in that excerpt reached the terminal raw, so
`cotal up` in a cloned project could clear the screen or set the window title. The same applied to an
argument a refusal repeats, such as an unknown command, docs page, preference key or channel name.
