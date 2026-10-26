---
"@cotal-ai/core": minor
"@cotal-ai/manager": minor
"@cotal-ai/cli": minor
"@cotal-ai/tmux": minor
"@cotal-ai/cmux": minor
"@cotal-ai/orca": minor
"@cotal-ai/herdr": minor
---

A foreground `cotal spawn` on a manager whose runtime streams no terminal now launches the agent
and stops there, instead of launching it and then failing `OPERATION_PARTIAL` on an attach that
runtime cannot open. Only the built-in `pty` runtime streams a terminal; `tmux`, `cmux`, `orca` and
`herdr` start the agent in a surface the manager does not own. A launch on one of those exits 0
with the agent running, and its receipt names the runtime, says the seat runs in the manager's own
session, and gives `cotal watch` and `cotal send` as the way to reach it. `--json` carries the same
answer as `result.streamsTerminal`. A `pty` manager still attaches.

`cotal attach <name>` on such a seat is refused once as `UNSUPPORTED`, carrying that runtime's own
guidance for watching the agent where it runs, and the reconnect loop no longer retries it. The
manager question's rows name each manager's runtime and whether a terminal attaches to its seats,
so the choice is informed before a launch.

Breaking for anyone who implements the `Runtime` contract outside this repo: `streamsTerminal` is a
required field, and a backend that streams no terminal must say so rather than leave a caller to
find out by catching the throw from `attach()`. The manager reports it to its callers on the launch
reply and in its presence card, and a manager that does not report it is attached to as before.
