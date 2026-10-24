---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

A project folder whose path contained a control character, such as a tab, a newline or an escape character, could be prepared with `space create` but never started: `up` wrote its stack journal and then refused it as an unsupported shape, and every next step led back to `up`. `space create` and `up` now refuse such a path, and a path with a bidirectional formatting mark, with `USAGE_INVALID`, exit 1, before anything is written, naming the character and saying to rename the folder. A folder renamed from such a path is told to adopt its journal with `space create <space> --adopt` and is no longer told to move back.
