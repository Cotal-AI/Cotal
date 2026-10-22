---
"@cotal-ai/auth": patch
---

A service registration can now carry the input and output schema closures of the commands it declares, and the service endpoint authority publishes them with the registration. Each closure is compiled under the schema profile to exactly the digest its command names. Before this, nothing published a per-user-auth service's schemas, so no caller could resolve its commands. A schema closure left out must already be in the contract store. An artifact that no declared closure names is still refused.
