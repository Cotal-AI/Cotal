---
"@cotal-ai/cli": patch
---

A flag typed with an en dash, an em dash or a minus sign, as autocorrect writes `--`, is now refused as a usage error that names the dash and the flag to type, such as `--yes` for `–yes`. It used to be read as an argument, and the refusal was about something else. After `--`, such a word is still an argument as typed.
