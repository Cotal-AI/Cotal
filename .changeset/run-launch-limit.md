---
"@cotal-ai/manager": patch
"@cotal-ai/runtime": patch
"@cotal-ai/connector-core": patch
---

A `cotal run start` or `resume` past the manager's limit of 8 runs activating at once is now a clean refusal. The manager refuses before it writes the run's admission, marks the refusal `not-executed`, and names the runs still activating, and the CLI reports it as `LIFECYCLE_BLOCKED`, exit 2, with the next step to wait until one has activated and run it again. Before, the manager wrote the admission first, and the CLI reported the refusal as exit 3 "Outcome unconfirmed" with a "retry" hint it then told the caller not to follow. The limit is now in the run docs.
