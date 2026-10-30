---
"@cotal-ai/connector-jcode": minor
---

Jcode seats now mirror the four `ItemTable` rows of Cursor's `state.vscdb` that Jcode 0.99.0 reads, adding `cursorAuth/cachedEmail`, and leave out blank values. The read is one read-only transaction that waits up to 2 seconds for Cursor's lock and creates nothing in Cursor's directory. A database it cannot read stops the launch with `cursor_state_unreadable` and a reason, where it used to report `private_state`. That includes a WAL-mode database without its `-wal` and `-shm` files and a key whose value is not text or is larger than 16 KB, both of which used to launch. A database with none of the keys removes the seat's copy.
