---
"@cotal-ai/cli": patch
---

`/history` in `chat` works on an open mesh. It reads the channel the way `cotal history` does,
because an open mesh runs no delivery daemon. It used to fail with "no responders" and a raw
delivery subject.
