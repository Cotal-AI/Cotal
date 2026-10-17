---
"@cotal-ai/web": patch
---

The web events-filter smoke now pins the live tap by the handler it registers. It checks that `ep.tap` registers `onTap` unwrapped, locates the `onTap` body by its declaration, requires that body to forward every frame, and refuses any reference to `chatOnly` in it, so a call spaced, split across lines or given type arguments is caught too. The old cell read a fixed 200-character window from the registration call, which never reached the handler and passed on an empty window when the anchor moved. No behavior changes.
