---
"@cotal-ai/connector-opencode": patch
---

Two overlapping launches of one OpenCode agent name no longer both start a server on the agent's database. The launcher now claims `serve.pid` with an exclusive create before it starts its server, so the second launch is refused, and it removes the record when its server exits only while the record still names that server, so a launcher whose server exits late no longer deletes a newer launch's record.
