---
"cotal-ai": patch
---

Fail a commit that adds a suite line to the frozen `ci-suites.txt` list.

The freeze has been a comment since #1052. A tail append is shard-stable and inventory-green, then conflicts the next PR. GitHub will not build a CONFLICTING PR, so that branch also gets zero CI. New suites go under `ci-suites.d/<sha256(name)>.txt`.
