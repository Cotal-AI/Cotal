---
"@cotal-ai/connector-core": patch
---

`cotal_send` without a `channel` no longer defaults to a channel the agent may only read. On a mesh that enforces ACLs, the default is now the first channel the agent reads and may post to, so a read-only announcements channel listed first is skipped. An agent that may post to none of the channels it reads gets a clear refusal before anything is sent, instead of a broker permissions violation. On an open mesh the default is unchanged. The remote gateway's advertised `cotal_send` text says the same.
