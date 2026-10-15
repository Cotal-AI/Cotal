---
"cotal-ai": minor
"@cotal-ai/core": minor
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
"@cotal-ai/runtime": minor
---

The command line resolves, validates and explains a command before it does anything. A usage error (an unknown command, an unknown flag, a missing value, or a first word a command does not declare as a subcommand) now exits 1 before the built-in connectors are seeded or any configuration is written. Before, every command but help reconciled the connector store first, so a mistyped flag installed the connectors and only then printed the refusal.

- Bare `cotal` names the selected space, lists the common commands and points a machine with no selected space to `cotal setup`. It starts nothing.
- `cotal help [command] [subcommand] [--all]` prints the command list or one command's or subcommand's help; `--help` and `-h` print the same. `cotal version` prints the version, as do `--version` and `-V`. Breaking: `-v` no longer prints the version and is refused; it is reserved for `--verbose`.
- Commands can declare aliases, subcommands with their own aliases, structured outputs and examples. This release adds `sp` (spawn), `a` (attach), `s` (status), `r` (run), `x` (ext), `h` (history) and `cotal ext rm`. A word is never matched by prefix. The registry refuses a name or alias another command already claims, and `cotal ext add` refuses an extension whose name or alias an installed extension claims, naming both.
- Completion resolves an alias as dispatch does.
