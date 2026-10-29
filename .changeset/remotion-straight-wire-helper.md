---
---

The delivery-mode and NATS README cards now build their straight wires through a shared `straightWire` helper in `remotion/src/modes/scene.tsx` instead of spelling out the 0.4 and 0.6 cubic control points at each call site. The rendered frames do not change. This touches the `remotion/` asset project only; no published package changes.
