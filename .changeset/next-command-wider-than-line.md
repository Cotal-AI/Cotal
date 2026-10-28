---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
---

Keep a command wider than the terminal line on one line, so a copied line is the whole command.

On an 80-column terminal the exec-endpoint `next:` of `cotal service` broke before `--handler <file>`, and the remedy of `cotal service add <name> --preset exec-endpoint` broke before its last `<file>`, both in the refusal line and in the `--plain` report's Next. Copying the first line gave a command without its last option, and copying both ran two commands. A command cell now overflows the line as one line, and so does a remedy that is one whole command: `CommandFailure` takes `remedyIsCommand`, which every terminal remedy path honours. A remedy that starts with a command and goes on as prose still wraps at its spaces. `--json` output is unchanged.
