---
"@cotal-ai/cli": patch
---

`cotal send --file` and `--stdin` read the body only to one byte past the broker's message limit before refusing it. A large file is refused with its size without being read whole, and an endless input such as `/dev/zero` is refused at the limit instead of growing until the process is killed.
