---
"@cotal-ai/cli": patch
---

A `down --preserve-state` that is refused after it stopped the delivery daemon (the manager refuses to prepare, an endpoint the manager does not manage is live, or a seat cannot be checkpointed) starts the daemon again, so the mesh it leaves can spawn, retire and join; before, the daemon stayed stopped until the next `cotal up` while the refusal read as a running, unfenced mesh. The live-unmanaged-endpoint refusal is classified (`LIFECYCLE_BLOCKED`, exit 2, with a next step) instead of an unknown outcome, and a daemon that cannot be started again is named in the refusal with `cotal up` as the remedy.
