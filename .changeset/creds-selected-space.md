---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

A command given `--creds` without `--space` or `--server` now uses the selected space, or else the space of the project it runs in, as it does without `--creds`. It used to send the credential toward `main` and refuse with "the default space "main" is not registered here" from the space's own folder and with that space selected. `join --creds` and `join --token` take the selected space the same way. When that space is not registered here, the refusal names it as the selected space or this folder's space, and puts it under `target`.
