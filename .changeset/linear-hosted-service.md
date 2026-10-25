---
"@cotal-ai/linear": minor
---

Serve registered Linear endpoints on user-auth meshes through the existing remote service authority and shared renewal source. Keep the original approval request and instance across retries and restarts, verify the signed serving grant against the embedded contract, and acknowledge readiness after subscribing. Caller access still requires an explicit instance-scoped grant. Stopping closes the local service and retains its approved registration without claiming remote revocation.
