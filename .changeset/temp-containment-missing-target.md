---
---

A smoke cleanup's containment guard now resolves a delete target that does not exist yet through its deepest EXISTING ancestor, rather than through its lexical spelling. Previously a missing target under a symlinked parent was certified as contained while physically resolving outside the root, so a guarded recursive delete could remove a directory the suite never minted. The existing counterpart was already refused; only the missing one was accepted, which is what made the hole hard to see.
