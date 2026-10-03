---
"@cotal-ai/manager": patch
"@cotal-ai/seat": patch
---

Stop starting a detached seat custodian for every default `pty` spawn on Linux. The built-in `pty` runtime now spawns in-process on every platform, the same as macOS and Windows, and reports `legacy` custody. On Linux it still adopts and reaps seats that an earlier manager left under a custodian, so existing seats drain under the new manager. Because the pty runtime can no longer spare its seats, a bare `cotal down` on Linux now asks for `cotal down --with-agents` while pty agents are running, as it already did on other platforms. The in-process pty runtime gives no hot-update guarantee. `cotal seats` lists the custody records an earlier Linux manager left, and `cotal seats --drain` retires each seat whose agent has exited. A seat whose agent still runs is never signalled, and a record that cannot be proved safe is refused and kept. A record with no start or boot identity, or one from an earlier boot, is refused by the read-only listing too, rather than reported as running or exited. The seat package exports the same inventory as `drainSeats`.
