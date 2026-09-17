---
"@cotal-ai/manager": patch
---

Submit seat input on the call that sends it. `input` wrote the text and its carriage return as one pty write, so a TUI harness read the return as the last character of the text rather than as the submit key: the text waited in the composer and the next call's return submitted the previous call's text. The return is now written on its own, and the text is written in slices under the pty's 4096-byte input buffer so no write is re-split by the kernel onto the return.
