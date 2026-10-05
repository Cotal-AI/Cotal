---
"@cotal-ai/cli": patch
"@cotal-ai/connector-jcode": patch
---

A foreground `cotal spawn` on an open mesh now publishes its AG-UI events. The launch passed the seat no id, so its endpoint made up a random actor for each process and the event emitter refused to start with `events are not available for a session with a self-minted identity`. The seat's Graph stayed empty although the spawn had succeeded. The foreground launcher now allocates an id on an open mesh, as the manager already does for detached seats, so this works for every connector with an event plane. The Jcode connector used to work around this by itself, using the seat name as its actor on an open mesh. That workaround is gone, and an open-mesh Jcode seat now gets the allocated id like every other seat.
