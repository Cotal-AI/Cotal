---
"@cotal-ai/core": minor
"@cotal-ai/runtime": patch
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

Make `EndpointReply` a union on `ok`. Failed replies require an error; successful replies cannot carry one. TypeScript callers must construct the matching reply arm and narrow `ok` before using a required error. Interfaces that extended `EndpointReply` must use a type intersection instead.

Keep acceptance data on local failed goal-follow results. The wire parser still rejects failed replies carrying data or missing their error. Narrowed readers no longer need fallback text for missing errors.
