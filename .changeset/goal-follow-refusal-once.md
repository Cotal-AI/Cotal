---
"@cotal-ai/core": patch
"@cotal-ai/connector-core": patch
---

A followed call to a manager that does not serve `goal-result` is now refused by one core check, `goalFollowRefusal`, on every path. Before, core and the user-credential connector path each built their own copy of the refusal, before the first submission and again after re-resolving, and the connector's copy was worded differently. A user-credential spawn now gets the same `failed-precondition` refusal, with the same message, as a static-credential one.
