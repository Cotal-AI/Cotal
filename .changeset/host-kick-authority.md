---
"@cotal-ai/core": patch
"@cotal-ai/delivery": patch
---

The multi-space delivery host (`cotal deliver --spaces`) is now the one process on a broker that kicks a live connection. When a space on its root retained the system-account signing seed, every lane evicts through the host's kick authority: the lane scans its own account, the host checks each connection against its own complete census of that account, mints a kick-only user that lives five minutes, kicks, and keeps no `$SYS` connection open between kicks. A lane opens no `connection-evictor` credential, so a space created before live eviction on a multi-space broker completes its eviction barrier without a system-account rotation, and no per-space process holds the broker-wide KICK. The host says which posture it runs at start. A single-space daemon is unchanged. Core exports the pieces the host uses: `KickTarget`, `kickConnection`, `accountHoldsConnection`, and a `kick` function the eviction sweep can delegate to.
