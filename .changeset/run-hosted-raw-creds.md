---
"@cotal-ai/runtime": patch
---

A hosted `cotal run` verb (`answer`, `show`, `ps` and the others the manager serves) refuses a raw `--creds` file `UNSUPPORTED`, exit 2, with one refusal envelope under `--json`. Its next step is to run the verb again without `--creds`, where the CLI mints the one-shot caller from the project folder or the `--space` registration. Before, it printed an unformatted line and exited 1, and `--json` printed nothing.
