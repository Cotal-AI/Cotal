---
"@cotal-ai/cli": patch
---

`cotal up` with no `--store-dir` reopens the store this folder's last broker served, such as a `backup restore --store-dir` target, when the default `.cotal/nats` holds no data, instead of refusing `CONFLICT` and asking for the path it already named. It prints the store it reopens. When the auth and open broker configs name two such stores, it still refuses, and `up -f` keeps its refusal.
