---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

`cotal service stop` and `restart` now signal the process group a background start leads and wait
for the whole group to exit. A server that a shell backgrounded no longer outlives the stop and
keeps the service's port. When a saved service's HTTP readiness address still answers while none
of its instances runs, `service stop`, `service status`, `cotal service`, `cotal status` and
`cotal down` print a `SERVICE_ADDRESS_HELD` warning naming the address and the process of this
account that listens there.
