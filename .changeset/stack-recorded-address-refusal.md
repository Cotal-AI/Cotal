---
"@cotal-ai/cli": patch
---

A controller stack's first `up` records its broker address, and an `up --server` naming another address refuses `CONFLICT`. That refusal said only "this root's stack journal names another space or broker address; it was not rebound", with no address and no next step, after a `down`, after a successful run, and after `space forget` and `space create`. It now names the recorded address and the address this `up` asked for, and its next step is the bare `cotal up` that starts the stack at the recorded address. A different `--store-dir`, `--max-file-store` or `--host` names each input it changes with its recorded value, and gives the same next step. `up --help` and docs/cli.md no longer call `--server` an override: a stack's first `up` records it.
