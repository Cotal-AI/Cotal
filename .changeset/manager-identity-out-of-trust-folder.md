---
"@cotal-ai/workspace": patch
"@cotal-ai/manager": patch
---

A manager's per-root identity no longer travels with a mesh's trust folder. The instance identity and the goal-writer and session-ledger identities now live in the root's own space segment, `.cotal/space.<space-hex>/manager-instance.json` and `manager-siblings.json`, instead of `.cotal/auth`. Copying `.cotal/auth` to another root, as the docs describe for a mesh you did not start, used to copy them too, so `cotal supervise` there was refused as the original manager while it ran, and came up as that same instance once it stopped. A root that still holds the records in `.cotal/auth` has them moved on first use and keeps its instance across the upgrade; both locations holding a record is refused. When the manager lease refusal comes from a manager in a different root, it now says "another workspace root" instead of "this workspace root", and it reports the holder of the conflicting instance's own lease.
