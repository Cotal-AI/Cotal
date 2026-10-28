---
"@cotal-ai/orca": patch
---

`currentTerminal` and `currentTerminalForWait` now share `resolveTerminal` and `isGoneCode`, so the synchronous status probe and the asynchronous exit wait resolve a terminal from `terminal list` and `terminal show` by one rule and classify gone error codes in one place. When a terminal's `ptyId` leaves `terminal list`, `currentTerminal` returns `undefined` without calling `terminal show` on the stale handle, and when `terminal show` returns an `ok` envelope with no terminal for a handle-only seat, `currentTerminal` throws the same authoritative-state error as `currentTerminalForWait` instead of returning the caller's input.
