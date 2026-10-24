---
"@cotal-ai/runtime": patch
---

A hosted `run start` refused for a program that does not validate now prints each problem with its
control characters escaped, as `run validate` does, so a step name cannot write terminal escapes.
