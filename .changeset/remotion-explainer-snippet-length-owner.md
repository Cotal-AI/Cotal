---
---

Each explainer and demo snippet in the `remotion/` asset project now exports its length, uses it for its own `loopEnvelope`, and `Root.tsx` registers it at that export. Every master sequences its snippets at their exports and exports its total as their sum, which its `loopEnvelope` and `Root.tsx` both read. A snippet used to restate its length in its own file, in `Root.tsx` and in every master that played it, so retiming it in its own file and `Root.tsx` left the masters cutting it short. The rendered snippets and masters do not change. This touches the `remotion/` asset project only; no published package changes.
