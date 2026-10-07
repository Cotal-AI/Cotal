---
---

Each README delivery-mode card now exports its loop length, and both `Root.tsx` and `HeaderModesReel` read it. The reel used to restate the three lengths and its own 555-frame total as literals, so a card retimed in `Root.tsx` kept playing at its old length inside the reel. The reel's total is now the sum of the card lengths and its outro. The rendered cards and reel do not change. This touches the `remotion/` asset project only; no published package changes.
