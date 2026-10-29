---
"@cotal-ai/manager": patch
"@cotal-ai/connector-core": patch
---

An open mesh's manager no longer mints credentials from a static stack's accounts left in the same folder. After a static `cotal up`, the first `cotal up --open` there ran its manager on those accounts and recorded the credentials it minted. The next open boot had to prove them gone through a delivery daemon, which an open mesh does not run, so it exited 1 after about a minute with `! control plane degraded:` and no manager. The manager now follows the mesh's recorded mode, so static and open boots can alternate in one folder.
