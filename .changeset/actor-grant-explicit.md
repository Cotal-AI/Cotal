---
"@cotal-ai/auth": patch
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
"@cotal-ai/workspace": patch
---

`cotal actor grant` no longer turns an omitted ACL flag into the wide default. A grant must name `--scope`, `--allow-subscribe` and `--allow-publish`, or pass `--full` to take `spawn,role:default`, `>` and `>` for the ones left off. Otherwise it refuses, writes nothing, and prints both forms. Dropping one flag from a narrow event-plane reader grant used to mint a row that read or posted to every channel, or could spawn, with a success line as the only sign. The hints printed by `cotal login`, `cotal status`, `actor list` and the not-granted refusal now include `--full`.
