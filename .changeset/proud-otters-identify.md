---
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
---

Pin every stack pidfile to its process's creation identity and refuse teardown of a pid it cannot prove. `up` writes a sibling `<pidfile>.identity` (pid plus the process start, where the OS reports one), and every stop path - `down` for the broker, web and extension components, and the manager, delivery and auth-service stops - runs one open-verify-terminate rule: a reused pid (pin mismatch) is refused and preserved, never signalled; legacy records without a pin and torn pins refuse loudly with the operator's next step; only an ESRCH-proven death clears a record and its pin. On Windows, where no cheap stable start token exists, the pin is not written and records take the loud legacy shape until the native launcher integrates with the seam.
