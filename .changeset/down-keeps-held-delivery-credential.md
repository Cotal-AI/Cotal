---
"@cotal-ai/cli": patch
---

`cotal down` reads the delivery lease after the delivery daemon stops and keeps the daemon's credential while the lease still names it. A daemon whose release a full JetStream store refused left that row as a killed one does, and the next `up` then started no delivery member, because the credential it needs to wait the row out had been removed. When the lease cannot be read, the credential stays and a `DELIVERY_LEASE_UNREAD` warning says so.
