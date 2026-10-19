---
---

The explainer's three-modes snippet now keeps each peer's name, role, presence and point in one array, and picks the peer that claims the anycast role as the first idle peer in it. The claim flash, the scripted status, the dimming, the claim beam and its afterglow follow that peer. It used a fixed index into two arrays joined by position, so reordering either array or moving the idle presence to another peer made a busy peer claim while the free peer was dimmed, and nothing failed. Rendering the snippet, or an explainer master that sequences it, from a cast with no idle peer now throws; the other compositions still render. This touches the `remotion/` asset project only; no published package changes.
