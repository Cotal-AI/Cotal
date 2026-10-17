---
"@cotal-ai/manager": patch
---

The events-grant smoke now decodes a credential's chat ACL with one `chatAcl(path, direction)` helper for both the publish and the subscribe side. It used to carry two copies of the same decoder that differed only in the ACL field, so a change to credential parsing or to what counts as a chat row had to be made twice, and an edit to one copy went unnoticed. No behavior changes.
