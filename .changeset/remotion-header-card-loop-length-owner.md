---
---

The HeaderMorph, HeaderAssemble and HeaderBanner header cards now export their loop length, and `Root.tsx` registers each card at that export. `Root.tsx` used to restate the three lengths as literals, so a card retimed in its own file kept its old registered length, and the render either cut the card before its fade-out or held blank frames after it. The header comments no longer repeat the frame counts. The rendered cards do not change. This touches the `remotion/` asset project only; no published package changes.
