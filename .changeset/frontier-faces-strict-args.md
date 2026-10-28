---
"@cotal-ai/example-04-frontier-faces": patch
---

`face-term.mjs` parses its command line with `node:util` `parseArgs` in strict mode and refuses an `--expr` outside the five persona expressions instead of ignoring unknown or valueless options and rendering the default face.
