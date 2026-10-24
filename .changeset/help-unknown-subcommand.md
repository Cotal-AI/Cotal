---
"@cotal-ai/cli": patch
---

`cotal <command> <word> --help`, where `<word>` names none of the command's subcommands, now refuses
as `cotal help <command> <word>` does, naming the nearest subcommand, instead of printing the
command's help with exit 0.
