---
"@cotal-ai/cli": patch
---

Option-parsing refusals name the spelling the command takes. An unknown option says to put `--`
before a word that starts with `-`, and an option value that starts with `-` is refused with its
`--name=value` form. `-c=general` and an option typed with a typographic dash are refused naming
the option meant, where they were read as the value `=general` or as a positional.
