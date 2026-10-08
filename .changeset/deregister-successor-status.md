---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
---

`deregisterServiceInstance` no longer deletes a successor's status. When a restart of the same instance re-registered and wrote its `ready` status between the deregistration's spec read and its status read, the deregistration deleted that status and reported `superseded`, so the successor kept serving while every class scatter, `cotal ps` included, skipped it as never converged. A status that observed a later registration than the spec read is now left alone. The `superseded` contract, the `cotal deregister-instance` refusal and the CLI docs no longer say nothing was removed: when the spec moves after the status delete, the inspected registration's own status is gone and its spec stays.
