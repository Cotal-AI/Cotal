---
"@cotal-ai/connector-core": patch
---

When an update replaces the connector's docs files under a running session, `cotal_docs` still refuses to serve another release's docs, and the refusal now names the release the session loaded and says to restart the session to read the docs of the installed version.
