---
"@cotal-ai/manager": minor
"@cotal-ai/cli": minor
"@cotal-ai/core": minor
---

`cotal input --name <seat> --text <text> [--no-enter]` types one line into a running managed agent's terminal and returns, so a program can deliver a harness command (`/compact`, `/clear`, `/model`) without holding an `attach` stream open. It is backed by a new manager op `input`, which carries the same row shape and the same authorization as `attach` (capability `manager.lifecycle`, targeted, authz modes `owner` and `any`), takes `{text, enter?}` with the text verbatim up to 64KiB, and answers `{name, bytes}`. Enter is appended unless suppressed; nothing is echoed back. The manager's cluster document is revision 7, so a caller's `describe` sees the new command. `AgentHandle` gains an optional `write(data)`: the `pty` runtime implements it, and the external terminal runtimes (`tmux`, `cmux`, `orca`, `herdr`) do not own the child's input stream, so `input` refuses and names the runtime rather than dropping the keystroke. The `spawn` capability's owner-mode lifecycle set gains `input`, which is the reach `attach` already had.
