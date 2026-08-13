---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"@cotal-ai/auth": patch
---

Stop reading another user's live process as dead.

Asking the kernel about a process has three answers, not two: it is there, it is gone, or it is
there but not ours to signal (`EPERM`). A two-state probe folds the third into "gone", and the
caller then acts on a running process as if it had died.

The repo already had a tri-state contract that gets this right, documenting itself as "consumed
everywhere". Two production files imported it. Sixteen other production call sites probed inline,
and **seven of the fourteen files handled `EPERM` correctly on their own while seven did not**, so
this was a coin flip repeated fourteen times rather than one broken helper.

Fixed, with the wrong answer named at each site:

| site | what the old probe did |
|---|---|
| `manager-proc.managerUp` | reported no manager, so `ensureManager` starts a second one onto a live one |
| `delivery-proc.deliveryUp` | same, for the delivery daemon: two daemons on one fanout |
| `auth` `agent-bearer` | "the user-auth service is not running, restart it with `cotal up`" about a service that is up |
| `auth` provider | same misread on the readiness path |
| `cli ext` | printed "stale pidfile" about a live extension, which is advice to delete it |

Both `up` functions also parsed their pidfile with `Number.isFinite`, which admits fractional and
out-of-range values `process.kill` throws on. They now use the contract's bounded parser, and treat
`unknown` as present: refusing to start beats double-binding a live process.

The contract moved from `implementations/cli/src/lib/pid.ts` to `@cotal-ai/workspace`, the widest
tier that may hold a local-process concept. **"Consumed everywhere" was never reachable and the
claim hid the gap:** `extensions/*` peer-depend `core` only, and a pid probe is not a wire concept,
so reaching them would mean leaking a local concern into the standard. The two extension-side
probes keep their own copies by construction, and the module now says so instead of overclaiming.

Covered by a new broker-free suite, `smoke:pid-contract`, which pins the parser boundaries, allocates
a genuinely dead pid by watching a child exit rather than guessing a high number, and asserts the
`EPERM` rule against a real `EPERM` (probing pid 1 unprivileged) while skipping that cell loudly
when the fixture cannot produce one. It also runs the two-state probe it replaces side by side, so
the defect is executable rather than described. Mutation-proved by mapping `EPERM` to dead, which
reddens that cell and only that cell.
