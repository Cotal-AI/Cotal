---
---

The `@reviewer` bracket in the README anycast card is now measured from the first and last peer of the shared cast and the node size. It used to be drawn at literal coordinates worked out from the peer points, so moving the cast in the scene module moved the peers out from under the bracket and its label with nothing failing. The rendered card does not change. This touches the `remotion/` asset project only; no published package changes.
