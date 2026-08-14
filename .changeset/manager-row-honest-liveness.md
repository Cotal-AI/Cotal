---
"@cotal-ai/cli": minor
---

Stop the setup status card from claiming the manager is running on the strength of a pid

The card rendered `✓ manager running` whenever `kill(pid, 0)` succeeded for the pid recorded in
`.cotal/manager.pid`. That establishes only that *a* process exists at that pid — not that it is a
manager, and not that it answers. A manager stopped with SIGSTOP still satisfies it, and so does an
unrelated process that inherited the pid after a restart; both were reproduced against a real
detached manager, with the card still green while an instance-pinned probe timed out.

The row now renders the full five-valued liveness and **no arm ticks green**:

- `alive` — `local process present (pid N · .cotal/manager.pid) · serving not checked`, naming the
  source of the fact and stating what was not checked
- `dead` / `absent` — `not running`, with the start command
- `unknown` / `unattributable` — names which condition could not be established and recommends no
  action

The start hint is earned rather than decorative: it appears only where the record positively says
nothing is there, because recommending a start over a record that may front a live process is a
double-launch. The pid and the state come from a single read, so the row cannot display a pid it
did not probe.

Behaviour change for anyone reading the card or scripting against it: a running manager now shows a
neutral marker and the words `serving not checked` instead of a green tick, and `cotal setup` no
longer offers a start command for a manager whose state could not be determined.
