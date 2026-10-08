---
---

The README anycast card now picks the peer that claims the `@reviewer` message as the first idle peer in the shared mode-card cast, and drives the claim flash, the scripted status, the dimming, the claim wire and its afterglow from that peer. It used a fixed index into the cast, so reordering the cast or moving the idle presence to another peer made the wrong peer claim while nothing failed. Rendering the anycast card from a cast with no idle peer now throws; the other cards, which share the cast, still render. The rendered card does not change. This touches the `remotion/` asset project only; no published package changes.
