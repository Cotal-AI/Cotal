---
"@cotal-ai/cli": patch
---

`cotal service start web --read-only` on a stopped dashboard saved with `--posting-creds` is now refused before it saves anything, and names the remove and read-only add that turn posting off. It used to save `--read-only` next to the kept `--posting-creds`, so that start and every later one were refused.
