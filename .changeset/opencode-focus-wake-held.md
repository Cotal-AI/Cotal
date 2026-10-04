---
"@cotal-ai/connector-opencode": patch
---

A focus `@mention` wake on OpenCode 1.x is no longer lost when an ordinary inbox turn fails. The wake used to be handed to the turn driver and written back by hand at each exit that did not submit it, so a failed submission of a turn that carried no wake wrote an empty value over a wake that arrived while it was in flight, and the agent was never told it was mentioned. The `mention-wake` handler now records the wake in a pending slot, the driver only reads it, and only a submission that lands clears it, generation-checked so a wake that arrived meanwhile survives. Message bodies are still not buffered, so a channel with replay off still gives back nothing to recall.
