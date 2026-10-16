---
"cotal-ai": minor
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
"@cotal-ai/web": minor
---

Commands share one structured output contract, and every command takes `--no-color` and `--no-input`.

- `cotal version --json` (or `-j`) writes one JSON document on stdout: `schemaVersion` 1, the command, a `null` target, the outcome, completeness, the result (the version and each installed extension's), and warnings. A usage error under `--json` is one `refused` document with code `USAGE_INVALID` and a remedy, and the help it names stays off stdout. A command with no JSON output refuses `--json` as an unknown option.
- A command that declares a JSON output exits by its outcome: 0 for ok or no-op, 1 for a usage refusal, 2 for a refusal at a known boundary, 3 when the outcome is unknown, 4 for partial, 5 for failed. An error such a command does not classify is unknown. Other commands keep exiting 1 on any failure.
- `@cotal-ai/workspace` exports the envelope and NDJSON record types, the stable error codes, the outcome-to-exit table, and `CommandFailure`, which keeps an endpoint's own code and outcome under `error.cause`.
- `--no-color` turns color off for that run, including the setup prompts, whatever `FORCE_COLOR` says; the programs it starts are no longer forced into color by `FORCE_COLOR`. `--no-input` means no prompt, editor or browser: a prompt behaves as it does without a terminal, `cotal web` prints its link without opening it, and `cotal personas edit` is refused. `--json` implies `--no-input`. Both flags work before the command word, and after it on any command that does not take its words raw.
