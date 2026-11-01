The Auth host API provides lifecycle, enrollment, human-proof, and consent operations on the auth service's loopback listener.
These host-only routes return HTTP 404 on the public listener.

## Connection

The owner-private auth-service discovery record provides the loopback port and exchange capability.
Query strings and trailing slashes do not match host routes.

## Authentication

Host-only operations require `Authorization: Bearer <capability>` and `Content-Type: application/json` headers.
Requests with an `Origin` header are refused. The body limit defaults to 64 KiB.

The loopback listener also serves shared Auth routes. Protected shared operations require the host capability in addition to their request proofs.
Their request and response shapes are documented in the [public Auth reference](/api/auth/).
Elevated exchange views and operator host operations remain loopback-only.

Operation pages describe the capability checks, lifecycle conditions, and response codes for each host-only route.
