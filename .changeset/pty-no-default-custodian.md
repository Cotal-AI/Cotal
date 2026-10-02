---
"@cotal-ai/manager": patch
---

Stop starting a detached seat custodian for every default `pty` spawn on Linux. The built-in `pty` runtime now spawns in-process on every platform, the same as macOS and Windows, and reports `legacy` custody. On Linux it still adopts and reaps seats that an earlier manager left under a custodian, so existing seats drain under the new manager. Because the pty runtime can no longer spare its seats, a bare `cotal down` on Linux now asks for `cotal down --with-agents` while pty agents are running, as it already did on other platforms. The in-process pty runtime gives no hot-update guarantee.
