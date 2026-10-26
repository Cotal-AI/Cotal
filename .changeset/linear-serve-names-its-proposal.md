---
"@cotal-ai/linear": patch
"@cotal-ai/cli": patch
---

`cotal linear serve` on a user-auth mesh now names the proposal it is waiting on. Its `PERMISSION_DENIED` refusal used to say only "approve the original proposal in the selected space", so the owner had no id to approve. The Next line now names the proposal and the exact command, `cotal service-endpoint approve <proposalId> --caller-ceiling linear.mcp --space <space>`; the `linear.mcp` ceiling lets callers be granted the five Linear commands, which an approval without it never allows.

A flag a `cotal linear` operation does not take is refused naming that flag, the flags the operation does take and its usage, instead of "a supplied flag does not belong to this Linear operation". `linear serve --json` now says that serve is a foreground service with no `--json` or `--plain` output, and `linear account login --json` names `--plain` as its only output flag.

`cotal help` shows a usage that declares several forms, one per line, with each form on its own lines. `cotal linear --help` used to print its nine forms joined by an escaped `\u000a`. Each `linear` operation's help now shows its own usage line too.
