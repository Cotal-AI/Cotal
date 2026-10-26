---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

On a user-auth mesh, when some of your managers do not answer, `cotal ps` and `cotal who` name each of them by instance id in their Next, so a registration left by a manager that ended without a clean stop can be told apart from the managers that answer. The Next used to say only to retry or read one manager with `--on`.
