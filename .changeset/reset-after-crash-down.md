---
"@cotal-ai/cli": patch
---

After a crash on a controller stack, `cotal down --yes` now leaves a root that `cotal reset store`, `cotal reset space` and `cotal clean store|all --force` accept. That `down` finds every member gone and records it as already stopped, and these commands, which remove the store, now count such a member as stopped. They used to refuse it for having no stop receipt and name a `down` that changed nothing, so the only way out was a full `up` and another `down`. A reset refused before that `down` now names `cotal down --yes`. Backup still requires each member's own stop receipt.
