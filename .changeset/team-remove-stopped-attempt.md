---
"@cotal-ai/cli": patch
---

`cotal team remove <id>` now removes what an incomplete `team deploy` created, such as a deployment whose agent exited on launch. Before, such an attempt stayed unsettled, and `team remove`, bare `cotal down` and every later `team deploy` refused with no way out. Removal works when the attempt's own journal records every effect: in manifest order, each channel and agent reached its accepted step or was never submitted. It then uses the guarded route of a returned deployment of the same shape. Each allocated agent is retired through the original manager by its identity and lifecycle UID, with no stop for one the manager already retired, and each card is deleted at its accepted create revision. A step submitted with no recorded acceptance, or an unreadable record, still refuses with `LIFECYCLE_BLOCKED`, now naming that step. Nothing is retried, and no attempt record is changed or deleted.

An incomplete `team deploy` now names `cotal team remove <id> --dry-run` as a next step. Bare `cotal down` and a later `team deploy` that a retained deployment blocks now name the removal of each such deployment.
