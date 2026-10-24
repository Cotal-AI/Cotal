---
"@cotal-ai/runtime": patch
---

`cotal run show` and `cotal run journal` take `--limit <n>`, from 1 to 1000, for how many of the
last journal rows the text view prints. The view printed only the last 20, and the only way to read
more was `--json`. `--limit` with `--json` is refused, since the JSON result holds the whole journal.
