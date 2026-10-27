---
"@cotal-ai/cli": patch
---

Ctrl-C on a bare `cotal down` of a stack a plain `cotal up -d` started, the retained launcher whose stop lines name each process and its pid, no longer ends it silently with the stack partly stopped. It now exits 130, 143 or 129 with a notice that names the members it stopped, those still running and `cotal down --yes` to finish the stop. A signal that lands while a member it already signalled is exiting waits for that exit, so the member's stop line prints first and `cotal status` no longer reads the stopped broker as a stale pidfile or an exited broker to restart. A second signal ends the stop at once and names the member whose stop is not confirmed.
