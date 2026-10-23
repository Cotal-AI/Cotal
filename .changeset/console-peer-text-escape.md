---
"@cotal-ai/cli": patch
---

`cotal console` now shows a control character in a peer's message body, name or other text as its `\uXXXX` escape, in both `--plain` and the TUI, as `history` and `watch --plain` already did. `console --plain` wrote a body to the terminal as it arrived, so a message could clear the screen, set the terminal title, plant an OSC 8 hyperlink, ring the bell or overwrite its own line with a carriage return. The TUI passed the title and hyperlink sequences through too. The TUI still shows a body's line breaks.
