---
"@cotal-ai/cli": patch
---

A `chat --stdio` session sometimes never wrote its own presence `joined` record, and never wrote one for the members already online: what the session reported while it started, before its front end subscribed, was dropped. The front end now gets it, so the session's own row and each member already online come as `joined` as it opens.
