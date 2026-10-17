---
---

The README unicast card now looks up its addressee, bob, when it renders instead of when its module loads, and derives the inbox-to-bob wire there too. Root and the header reel import every mode card, so a shared cast without bob used to refuse every composition in the project with the unicast card's error, including the multicast and anycast cards that never address bob. Now only the unicast card, and the header reel at frames inside its unicast segment, refuse that cast. The rendered card does not change. This touches the `remotion/` asset project only; no published package changes.
