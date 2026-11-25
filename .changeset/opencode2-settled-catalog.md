---
"@cotal-ai/connector-opencode": patch
"cotal-ai": patch
---

On OpenCode 2.x, `cotal models --harness opencode` lists every model instead of an empty list, and a pinned model is checked against the server's complete list. OpenCode answers its model list before its plugins have loaded, with nothing or only some providers' models. The catalog now starts a private `opencode serve --stdio` and the seat's model check reads the list only after `GET /api/plugin` lists a plugin, as `opencode models` does. An empty list, or plugins that do not load in time, reports the catalog unavailable with the reason.
