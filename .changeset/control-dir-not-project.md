---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

`space create` and `up` refuse a folder that is, or is in, a control directory, such as a running project's `.cotal`, judged by the path given and by the path its links lead to. They used to prepare and start a second stack there, writing a `.cotal` among that project's credentials and records. The refusal names the project folder to run from.
