---
"@cotal-ai/web": patch
---

The web events-filter smoke now pins the live tap by the handler it registers. It checks that `ep.tap` registers `onTap` unwrapped, locates the `onTap` body by its declaration, and requires that body to forward every frame with no `chatOnly` call. The old cell read a fixed 200-character window from the registration call, which never reached the handler and passed on an empty window when the anchor moved. No behavior changes.
