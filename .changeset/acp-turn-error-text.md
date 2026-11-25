---
"@cotal-ai/acp": patch
---

When an agent's turn fails in an ACP client such as T3 Code, the error now shows the application's own message and error kind, such as Codex's usage limit, in place of "run failed". The bridge reads the text and kind from the agent's presence condition, waiting up to 2 seconds for it after the run fails, because the run error on the event channel carries only the fixed text `run failed`. The prompt's error reads `<agent>'s turn failed: <message> (<kind>)`, without the `Internal error:` prefix, and its `data.condition` holds the condition's `code`, `source` and `message`. A condition the agent showed before the prompt, or one that waits on an approval or an input, is not taken as the reason. With no condition the error still says the turn failed.
