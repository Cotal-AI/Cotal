---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
"@cotal-ai/manager": patch
"@cotal-ai/auth": patch
---

Make usage errors and prompts behave as documented. Every CLI question, including the typed-name confirmation of `space delete`, the `--plain` removal questions of `channel remove` and `persona remove`, and the `manager` and `login` questions, now treats Ctrl-D on an empty line or a closed input as the cancel Ctrl-C gives, instead of hanging or exiting 13 with Node's unsettled-await warning. `up` refuses an invalid `--max-sessions`, `--max-file-store` or `--restore-only` value, and a restore flag combination it cannot run, as a usage error before anything runs instead of an unconfirmed outcome. `--json`, `-j` and `--plain` may come before the command word, and a leading `--` ends the leading flags. A command that takes its words raw refuses them there. A usage refusal from a command's own checks, from `clean` and from `help` with an unknown subcommand prints the error, its remedy and the command's help, like the parser's own usage errors. `space delete` names a prepared space that is not running and how to start or forget it, its dry run exits 0 when it reads its whole scope, `space forget` no longer calls a stopped space never started, and the `-y` help reads correctly for delete.
