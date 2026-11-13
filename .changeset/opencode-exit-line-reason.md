---
"@cotal-ai/connector-opencode": patch
---

A failed OpenCode launch now ends on the connector's own reason. When the plugin refused to start, for example under a name whose transcript the state root cannot continue, the launcher's final line was a generic "exited before its Cotal session was ready", and that line is all the Manager reports as a failed launch's last output. The final line now repeats the connector's last message.
