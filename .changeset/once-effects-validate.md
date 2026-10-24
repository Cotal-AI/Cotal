---
"@cotal-ai/lang": patch
---

`run validate` and a hosted `run start` now refuse an effect other than `ask` inside `once`, in its
body or in a function the body calls by name, with L2033. Such a program used to validate and then
fail every run with L4028.
