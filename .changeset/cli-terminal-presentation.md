---
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
---

`@cotal-ai/workspace` adds the shared terminal presentation: one report view model rendered rich (color and state marks) or plain (no ANSI, no marks), tables aligned by display width that become one labeled record per row when the terminal is too narrow, and `writeResult`, which writes one result as the JSON envelope or as its report. `presentationOf` reads `--json` and `--plain` and refuses both at once. Color tokens carry meaning (blue for commands and the selected item, green for done, amber for waiting, red for failed), and a state mark must be accompanied by its word.

Untrusted text in any report, and every value `oneLine` escapes, now shows bidirectional controls as `\uXXXX` escapes too, so a name cannot reorder what the terminal shows.
