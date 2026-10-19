---
"@cotal-ai/example-04-frontier-faces": patch
---

`face-term.mjs` refuses a bad command line. An unknown or misspelled flag, a flag with no value, and a flag that takes the next flag as its value now fail with an error, and `--dump --expr` refuses a name outside the five expressions. Each of these used to render the default face and exit 0, so a typo such as `--persnoa` or a trailing `--password` went unnoticed.
