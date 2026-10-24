---
"@cotal-ai/cli": patch
---

`clean restore-attempt` refusals, and `clean restore-fallback` without `--attempt`, are now refusals with a code and a Next naming the attempt the root records and its step. An option given with no value, such as a bare `--attempt`, is refused naming the option and its placeholder instead of the parser's "argument missing".
