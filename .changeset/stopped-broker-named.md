---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

On Linux, a broker on a loopback address whose process is stopped by a signal, such as SIGSTOP, is
named with its pid instead of waited on. Once the first dial times out, the refusal names the pid
and gives `kill -CONT <pid>`, without the longer confirm, so `run ps` returns in about 3 seconds
instead of 35. `cotal status` shows the connection as `broker process <pid> is stopped` and offers
the same command, and `down` refuses at once from the broker's recorded process state.
