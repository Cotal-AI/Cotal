---
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-claude-code": patch
"@cotal-ai/connector-codex": patch
"@cotal-ai/connector-jcode": patch
"@cotal-ai/connector-opencode": patch
"@cotal-ai/connector-hermes": patch
---

Tell every agent where to talk when it joins. A fresh agent can start on no channel, so the Claude Code, Codex, Jcode, OpenCode and Hermes startup text now says how to find its team's channel with `cotal_channels` and `cotal_join`, to use `cotal_dm` for one peer and `cotal_anycast` for a role, and to post on `#announce` only for a deliberate space-wide notice. OpenCode and Hermes previously carried no channel guidance at all. This is guidance only: no grant, subscription, mention or wake behaviour changes.
