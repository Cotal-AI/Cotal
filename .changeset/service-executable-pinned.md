---
"@cotal-ai/cli": patch
---

`cotal service add` now looks a bare executable name, such as `python3`, up on its `PATH` once and
saves the absolute path it finds, so a later `start` runs the same file whatever the starting
shell's `PATH` is. A `PATH` with a relative or empty entry refuses that lookup, as a unit install
does. The add receipt shows the saved executable. A definition saved with a bare name by an earlier
release refuses to start and says to add it again.
