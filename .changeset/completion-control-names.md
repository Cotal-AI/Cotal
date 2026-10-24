---
"@cotal-ai/cli": patch
---

Shell completion no longer offers a candidate that holds a control character, such as a persona
file named with an escape sequence or a newline. Before, the stub put that escape into the shell's
candidate list, where a listing wrote it to the terminal, and a newline in the name added candidate
lines of its own, including a forged directive. `cotal persona` still lists the file with the
characters escaped.
