---
"@cotal-ai/connector-opencode": minor
---

The OpenCode plugin holds a native prompt behind every turn end still settling on its session, not the latest alone, and a prompt already waiting follows each turn end reported while it waits. A turn that ends twice, by its error and by the idle that follows, had its barrier replaced by the later turn end, whose position read could answer first and delete it while the error's read was still pending, so a prompt typed in that window landed ahead of the error's position and the failed turn closed as a finish with its successor carrying the error; a prompt that arrived between the two ends waited on the first barrier alone and went through once that read answered, ahead of the idle's position.
