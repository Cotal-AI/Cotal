---
---

Each header card (`HeaderMorph`, `HeaderAssemble`, `HeaderBanner`) in the `remotion/` asset project now exports its loop length, uses it for its own `loopEnvelope`, and `Root.tsx` registers the card at that export. Each card used to state its length both in its own file and as a literal in `Root.tsx`, so retiming a card in its own file left `Root.tsx` registering the old length. The rendered cards do not change. This touches the `remotion/` asset project only, with no published package changes.
