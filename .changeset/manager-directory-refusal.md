---
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
---

Manager directory commands now tell you to pass an absolute path on the manager host when you supply a relative one. The CLI reports a confirmed refusal without echoing the supplied path.
