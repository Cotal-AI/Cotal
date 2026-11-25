---
"@cotal-ai/acp": minor
---

An ACP thread is now titled with the name its agent shows, and the title follows the agent when `/name`, the agent's own label or a rename made elsewhere changes that name. `cotal acp` sends ACP `session_info_update` with the title when a thread starts, loads or opens its agent, and again whenever the agent's presence shows another name, read as `meta["ai.cotal.label"] ?? name`. The session list and `/open` read the agent's label the same way. Renaming a thread in the client does not rename the agent.
