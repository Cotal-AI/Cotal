---
---

The three README delivery-mode card animations no longer state a loop length in their header comments. The Unicast and Anycast headers said 210 and 180 frames while the cards register and render at 168 and 162; each header now points to `Root.tsx`, which sets the length. The rendered cards do not change. This touches the `remotion/` asset project only; no published package changes.
