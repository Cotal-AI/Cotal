---
"@cotal-ai/manager": minor
---

The manager's spawn door now applies the same persona-ownership rule its redefine door always had.
`opDefinePersona` refused to let a peer redefine a persona it did not own, and was fail-closed on
ownerless files (legacy or operator-written). `opStart` checked nothing: it resolved the name,
loaded the file, and launched it for whoever asked. So a peer could not edit `deploy_runner` but
could spawn it, and ownerless — the redefine door's most conservative case — was the spawn door's
most permissive one.

Both doors now call one extracted predicate rather than two copies, so the rule cannot drift on the
door nobody is reading. New `personaIsolation` manager option, defaulting to `shared` — the
historical behaviour byte-for-byte, so a manager whose callers are one operator does not begin
refusing its own catalog on upgrade. `owner` confines each caller to the personas it owns; an
operator (admin tier) still reaches all of them. The check runs on the loaded persona, not the
resolved path, so `--config <elsewhere>` cannot walk around the catalog.
