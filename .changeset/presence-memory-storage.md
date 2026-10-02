---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
---

Create the presence KV bucket in memory storage, at `cotal up`, at restore and when an open-mode endpoint creates it. A file-backed presence bucket could latch a broker write error that refused every later presence write, and so every new join, until the broker restarted. A bucket created file-backed by an older version keeps file storage until its stream is recreated. `cotal up` now warns about a broker below nats-server 2.14.5 only when the space's presence bucket is still file-backed.
