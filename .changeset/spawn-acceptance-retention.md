---
"@cotal-ai/manager": patch
---

The manager no longer keeps every spawn acceptance for the life of its process. An acceptance is dropped five minutes after its goal ends, and an in-flight goal's acceptance is never dropped. A resubmission of a goal that has ended is answered from the goal's terminal and is never accepted again: a `succeeded` goal returns the same acceptance, and any other outcome is refused `failed-precondition` with its terminal attached. Before, a resubmission the manager no longer held in memory, such as one after a restart, ran the accept again and was refused with an error telling the caller to reconcile the store.
