---
"@cotal-ai/pi": patch
"@cotal-ai/core": patch
"@cotal-ai/connector-claude-code": patch
"@cotal-ai/connector-codex": patch
"@cotal-ai/connector-hermes": patch
---

`cotal spawn --agent pi --prompt <text>` now delivers the prompt as Pi's initial message (its first turn) instead of silently dropping it; an empty prompt, or one starting with `-` or `@`, refuses the launch. The connector contract no longer describes an initial prompt as something a connector may ignore: a connector delivers it or throws at launch. The other connectors follow the same rule: Claude Code and Codex refuse a prompt that is empty after trimming instead of dropping it, and Hermes refuses an initial prompt outright until its first turn is wired.
