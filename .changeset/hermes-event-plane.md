---
"@cotal-ai/connector-hermes": minor
---

Hermes seats now publish an AG-UI event plane, so ACP clients such as T3 Code and dashboards can show Hermes turns. The plane is armed by default like the other connectors' and `--no-events` turns it off. Hermes keeps no transcript a reader can resume at a cursor, so the plugin writes a turn journal from the gateway's message processing and the `post_api_request` and `post_tool_call` hooks, and the launcher reads it through connector-core's emitter. A run covers the messages the gateway processes at once, and shows the model's text and each tool call, with the call's arguments and result on the payload rail. A run shared by several messages ends with the outcome of the message that ends it, so a lone failed message ends its run with an error.
