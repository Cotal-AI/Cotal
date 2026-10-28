---
"@cotal-ai/core": patch
---

An unpinned endpoint invoke now reaches a service whose caller grant names only its instance. When the broker refuses the publish on the class queue, nothing ran, so the call goes once more to the rail of the instance that answered its describe. A granted agent's `cotal_invoke` and an unpinned `cotal invoke` therefore work without naming the instance; a credential that holds neither rail is refused as before.
