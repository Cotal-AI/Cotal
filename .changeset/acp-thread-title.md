---
"@cotal-ai/acp": minor
---

An ACP thread is now titled with the name its agent shows, and in T3 Code a title you give the thread renames the agent. `cotal acp` sends ACP `session_info_update` with the title when a thread starts, loads or opens its agent, and again whenever the agent's presence shows another name, read as `meta["ai.cotal.label"] ?? name`. Where the client lists a thread server in `mcpServers`, found by its `t3_thread_configure`, `t3_thread_read` and `t3_thread_update` tools as T3 Code's `t3-code` server offers them, the bridge sets the client's title there too. At the start of each prompt it reads the title, and one the person changed since the bridge last set or read it renames the agent before the prompt reaches it. A failed read or a refused rename is said in the thread, and the prompt runs. The session list and `/open` read the agent's label as well.
