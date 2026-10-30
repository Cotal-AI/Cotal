---
"@cotal-ai/connector-jcode": minor
---

Jcode seats no longer copy Cursor's whole `state.vscdb` into their private home. Each launch reads the four `ItemTable` rows Jcode uses, read-only and in one transaction, and publishes them as a fresh few-kilobyte database through the existing pinned rename. A database that cannot be read, or a WAL-mode one without its `-wal` and `-shm` files, stops the launch with `cursor_state_unreadable`. On Node older than 22.13, a host with a Cursor database stops with `cursor_state_node_unsupported`. Existing full copies are replaced on each home's next successful launch.
