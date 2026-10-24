---
"@cotal-ai/cli": patch
---

`cotal up --store-dir` and `cotal backup restore --store-dir` now refuse a path that is a link,
naming the directory it points to. `up` used to accept it and record the link, and every later
`reset store` and `reset space` then refused without naming a path. Those refusals now name the
recorded store path, and for a link the directory it points to and how to replace it.
