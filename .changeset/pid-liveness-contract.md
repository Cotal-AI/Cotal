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
out-of-range values `process.kill` throws on. They now use the contract's bounded parser.

The contract moved from `implementations/cli/src/lib/pid.ts` to `@cotal-ai/workspace`, the widest
tier that may hold a local-process concept. **"Consumed everywhere" was never reachable and the
claim hid the gap:** `extensions/*` peer-depend `core` only, and a pid probe is not a wire concept,
so reaching them would mean leaking a local concern into the standard. The two extension-side
probes keep their own copies by construction, and the module now says so instead of overclaiming.

Presence questions require PROOF (`=== "alive"`); only destructive questions preserve on doubt
(`!== "dead"`, which is why `down.ts` is written that way and is untouched). An earlier revision of
this change had the presence sites preserving too, and review reproduced what that buys: a permanent,
silent, retry-proof false-up, where the control plane reports `running: true` three times over
against an unreachable manager. The demonstrated defect was `EPERM` alone, and widening past it was
unforced.

Covered by a new broker-free suite, `smoke:pid-contract`. The errno-to-state mapping is a pure
exported function tested exhaustively, so there is no fixture to skip: the first revision reached the
`EPERM` rule only by probing pid 1 and hoping the process was unprivileged, and as root or in a
container that cell skipped while the suite still printed a passing banner over a deliberately broken
implementation. The suite also drives the CONVERTED CALLERS through real pidfiles, because the first
revision tested only the primitive and a reviewer inverted all five call sites without reddening a
single check.

Honest coverage limit, stated in the suite's own output: no cell can kill a caller mutation on the
`unknown` direction, since the two predicates differ only there and no accepted input produces an
`unknown` on a real kernel. That needs a syscall shim, which is how it was found.
