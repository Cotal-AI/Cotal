---
"@cotal-ai/cli": patch
---

`cotal send --stdin` refuses an oversized message as soon as it reads one byte past the broker's limit, without waiting for the writer to close the pipe.
