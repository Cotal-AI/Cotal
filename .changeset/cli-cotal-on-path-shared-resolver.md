---
"@cotal-ai/cli": patch
---

The CLI now decides whether a durable `cotal` is on PATH with the shared `resolveOnPath`, in one place. Before, `cotalOnPath()` kept its own scan that counted a directory named `cotal` as installed, so with such a directory on PATH, or with `.` on PATH in a folder holding a `cotal/` checkout, every hint printed a bare `cotal ...` the shell could not run and `npx cotal-ai setup` skipped the global-install offer. On Windows it now follows `PATHEXT` like every other PATH lookup. The recovery hint for an older binary no longer names npx's transient `cotal` shim when `.` is on PATH.
