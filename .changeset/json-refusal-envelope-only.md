---
"@cotal-ai/cli": minor
---

Under `--json`, a command that refuses or fails now writes its envelope alone and no text report on stderr. This changes every command's JSON refusal: until now each one also printed the human report on stderr beside the envelope, so a script reading both streams saw the refusal twice. The text report still goes to stderr when the envelope cannot be written to stdout, and exit codes are unchanged.
