---
"@cotal-ai/cli": patch
---

Reconcile update extensions in one staged prefix transaction.

Install compatible changed packages together, retain every package and registration check, and promote the complete verified prefix once. Failed package installation or validation leaves the live prefix unchanged. A protected promotion journal recovers interrupted directory swaps before extension declarations are read.
