---
"@cotal-ai/connector-jcode": minor
---

Jcode seats now mirror the four `ItemTable` rows of Cursor's `state.vscdb` that Jcode 0.99.0 reads, adding `cursorAuth/cachedEmail`, and leave out blank values. The read is one read-only transaction that waits up to 2 seconds for Cursor's lock. A database it cannot read stops the launch with `cursor_state_unreadable` and a reason, where it used to report `private_state`. A key whose value is not text or is larger than 16 KB now stops the launch instead of being copied. A database with none of the keys removes the seat's copy.
