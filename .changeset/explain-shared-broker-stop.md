---
"@cotal-ai/cli": patch
---

`cotal down` now names the registrations that block a controller stack from stopping its broker and shows how to inspect them before deciding whether to forget them and retry. It still refuses to stop the shared broker and never forgets the other registrations automatically.
