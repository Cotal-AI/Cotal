---
"cotal-ai": minor
---

`cotal daemon … --daemon-home <dir>` runs and reaches a separate daemon whose state lives in that directory: its own sign-in session, per-space identity, register request and service store, its own socket under `$XDG_RUNTIME_DIR/cotal/home-<hash>/daemon.sock`, and a lifetime lock at `<dir>/daemon.lock` that `serve` holds while it runs. The directory must already exist as an absolute 0700 directory you own, and cannot be the Cotal home. It runs beside the default daemon and copies nothing from it, so it needs its own `login`, `register` and owner approval. Spaces are still read from the shared Cotal home's mesh registry. Clients send nothing unless the process at that socket is the lock's live owner. A second `serve` for the same home refuses `CONFLICT` (`LOCK_HELD`), and a socket left by a killed daemon is still refused and never removed. Without the flag nothing changes.
