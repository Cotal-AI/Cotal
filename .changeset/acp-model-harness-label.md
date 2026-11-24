---
"@cotal-ai/acp": patch
---

T3 Code users can now see which application each model runs on and pick it from the model list.
Each model choice's name now starts with its application, such as `claude: Claude Opus 4.5` or `jcode: default`. T3 Code flattens the grouped model list and drops the group names, so the application was not shown anywhere, and the model choice is the only place a thread picks it. Clients that show groups keep them.
