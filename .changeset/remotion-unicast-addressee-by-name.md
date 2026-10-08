---
---

The README unicast card now picks its addressee, bob, from the shared cast by name and derives its subject from him. It used to take whichever peer came first in the cast, so reordering the cast moved the delivery to another peer while the subject still named bob. The rendered card does not change. This touches the `remotion/` asset project only; no published package changes.
