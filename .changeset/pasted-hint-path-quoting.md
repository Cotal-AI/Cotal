---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

Three hints that name a project path now quote it when a shell would split or expand it, so they can be pasted: the `cotal space create <space> --root <path>` that `status` names after a forget, the `chmod u+w` a persona catalog that cannot be written names, and the `cotal up --root <path>` that `status` names to restart a stack's stopped members.
