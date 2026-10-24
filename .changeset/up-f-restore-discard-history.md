---
"@cotal-ai/cli": patch
---

`cotal up -f` refused over an active restore that left history or workflow runs out now names
`backup cleanup-fallback <attempt> --yes --discard-history` as the step that retires it, and says
that it deletes the previous store, where it used to name a cleanup that then refused.
