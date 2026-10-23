---
"@cotal-ai/cli": patch
---

When the broker a controller `cotal up` started cannot create the space's streams, `up` now stops that broker again and fails `OPERATION_FAILED` (exit 5), so the next `up` starts a fresh one. The failure names the cause when the broker's log shows it ran out of open files, with raising `ulimit -n` as the next step, and otherwise names that log. It used to exit 3 with no cause and keep the crippled broker, which every later `up` reused and failed on.
