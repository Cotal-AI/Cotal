---
"@cotal-ai/cli": patch
---

`cotal attach`: pressing the detach key during a reconnect gives the shell back at once, instead of
at the end of the backoff rung.

The detach itself was always immediate: the terminal came back and `detached from <seat>` printed a
moment after the press. The process then stayed alive until the backoff wait it had already
abandoned ran out. Losing a `Promise.race` does not stop a `setTimeout`, and the timer is ref'd, so
node kept the command open to the end of the rung. On the 30s rung that is half a minute of a shell
that has said it detached and will not give the prompt back. Measured before the fix: 27.0s from
press to exit with the next attempt 26.9s away, and 8.3s with it 8.1s away, tracking the rung rather
than any work being done; 0.1s after it.
