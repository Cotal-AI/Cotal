---
---

The multicast and anycast delivery-mode cards now draw their wires to the peers through one fan helper in the asset project's scene module. Each card used to keep its own copy of the curve and of where a wire stops short of a node, so an edit to one copy left the two cards out of step with nothing to report it. The rendered cards do not change. This touches the `remotion/` asset project only; no published package changes.
