---
"@cotal-ai/cli": patch
---

`cotal attach` recognises the detach key when the terminal encodes it as a kitty keyboard protocol or xterm modifyOtherKeys sequence, in the session reader and in the between-sessions reader, keeping the whole-chunk match so a paste carrying the byte is still data (#598).
