---
"@cotal-ai/connector-opencode": patch
"@cotal-ai/connector-core": patch
---

An OpenCode 2.x agent that answers a direct message in chat only, with no Cotal reply, now gets one reminder to reply with a Cotal tool. The connector records a reply when `cotal_dm`, `cotal_send` or `cotal_anycast` succeeds. A turn that carried a live direct message, role request or @mention and ended cleanly without one is followed by a single short turn that leaves the choice to reply with the agent. `@cotal-ai/connector-core` exports `MESH_ACTIONS`, the intent-to-tool map the orientation card shows.
