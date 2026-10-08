---
"@cotal-ai/example-04-frontier-faces": patch
---

`face-term.mjs` refuses a `--persona` that names no persona and lists the known keys, as the browser `<cotal-face>` engine does. It used to render the ray face and exit 0, so a typo in `--persona` or in an agent file's `face:` key put the wrong face on the wall with nothing to say why.
