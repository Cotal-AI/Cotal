---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
---

A manager's clean stop no longer deletes a successor's service registration. When another process had registered the same manager instance before the stop ran (for example after a long pause, or a successor that started while the stop was still draining), the stop removed the successor's record and every later `cotal ps` failed with `service "manager" has no live registered instances`. `deregisterServiceInstance` takes an optional `registrationRevision` and returns `superseded` without deleting anything when the spec is at another revision. The manager passes the revision it registered at; `cotal deregister-instance` stays unpinned.
