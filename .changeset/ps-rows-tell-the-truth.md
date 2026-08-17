---
"@cotal-ai/cli": patch
---

`cotal ps` prints what the manager reports instead of folding it into one false word.

Every row carried two facts, the process (`running` or `exited`, with its age) and the mesh presence, and the CLI printed only the second. A seat whose process has been up for two days but whose mesh session dropped rendered as `offline`, and a seat with no roster entry rendered as `starting...` regardless of age. Both are false statements about a live process. Rows now print both facts, `running 2d 10h  mesh offline`, so the reader can tell a fresh start from a seat that never joined, and a live process from a dead one.

A registered manager instance that gives no answer within the deadline is no longer labelled `unreachable`, which is a network verdict the client does not hold; it prints `registered, no answer within the deadline` and says that a dead host never deregisters itself. `attach` and `stop` say the same instead of telling the operator to retry against an instance that may never answer.
