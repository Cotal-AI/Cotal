---
"@cotal-ai/cli": patch
---

Join shows a valid example when a channel starting with `#` is still invalid without that prefix. It still accepts a single display `#` on `--channel` and gives a usable override when a link includes that prefix on a valid channel name.
