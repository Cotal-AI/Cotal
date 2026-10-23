---
"@cotal-ai/cli": patch
---

`cotal send` refuses a lone `-` and names `--stdin` and `--file -`, which read stdin. It used to
publish the text "-". An empty quoted body is refused as empty. It used to be told to choose one
body. These refusals now suggest the destination you gave.
