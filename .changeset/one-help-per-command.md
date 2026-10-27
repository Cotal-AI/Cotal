---
"@cotal-ai/cli": patch
---

`cotal manager <verb> --help` and `cotal help manager <verb>` now print one help: the verb's own summary, usage and examples, with the options the command takes. `--help` showed the service command's summary, and `help manager <verb>` listed only `--json` and `--plain` under Options while its usage named `--foreground` and `--name`. `cotal ext seed --help` prints the `ext seed` help instead of the `ext` help.
