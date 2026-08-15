# Observation — `cotal status` renders two rows under the label `delivery`, and one of them is the signal the incident refuted

Filed by fm-health, 2026-08-15 (times measured with `date -u`). **An observation, not a fix**: the
row at `:174` is not this lane's code, and I am not silently changing another surface's output.

## The measurement

`implementations/cli/src/commands/status.ts:174`

    row(component.name, `${formatProc(state)}${detail}`);

renders one row per local process, labelled with `component.name`. The delivery daemon's descriptor
is `implementations/cli/src/index.ts:436-443`:

    { kind: "local-process", name: "delivery", label: "delivery daemon", order: 20,
      pidFile: "delivery.pid", artifacts: ["delivery.creds"] }

**The renderer uses `name`, not `label`.** So the row prints as `delivery`, not `delivery daemon`.
Its value comes from `pidfileState` via `formatProc` (`status.ts:483-488`): `running (pid N)` when
the pid is live, otherwise a note or `down`.

Before the rename in this lane, `status.ts:299/342/347` also rendered under the label `delivery`.
**Two rows, one label, on the same screen, from different evidence classes.**

## Why this is not cosmetic

The `:174` row answers "does a process exist under this pidfile". That is **precisely the weak
signal this lane's charter forbids as liveness** — the incident was a daemon whose absence nobody
noticed, and a pid check is the check that would have been trusted to notice. The `:347` row answers
"did the daemon affirmatively answer a bounded round-trip". Under one shared label an operator reads
them as two statements about the same thing, and the one that looks more definite — `running (pid
12345)` — is the one carrying less evidence.

This is the `daemonKnown` shape and the `managerHasDeliveryMarker()` shape again: a fact about the
machine wearing the name of a fact about the service.

## It also silently corrupted this lane's own cells, and a from-scratch cell cannot see it

`implementations/cli/smoke/_output-invariant.ts:26-29` selects a row by its FIRST TOKEN:

    export function rowLabel(line: string): string | undefined

and the cells select their subject with `plain.find((l) => rowLabel(l) === "delivery")`. `.find()`
returns the FIRST match. The pidfile row is emitted at `:174`; the health row at `:347`. **The
pidfile row comes first.** So on any mesh where the local-process section renders, the cells were
selecting the wrong row and asserting about it.

They were green throughout. That is not luck about the assertion — it is the environment: a cell that
builds its mesh from scratch has no `delivery.pid`, and the local-process section is reached only
after the early returns at `:145`/`:161`. **The colliding row does not exist in the state the cells
construct**, so the defect is invisible to exactly the cells written to catch defects here. This is
the charter's own warning, met in my own instruments: *state built from scratch cannot exercise a
defect that only exists in state built earlier.*

The rename to `delivery-health` removes the collision. It does **not** remove the fragility of
selecting a subject by first token: `.find()` still takes the first match, so a future row whose
first token is `delivery-health` would silently redirect every assertion in both cells.

**The obvious hardening is NOT applied here** — asserting that exactly one row carries the label,
rather than taking the first that does. It is one line per cell and it is what would make the rename
a proven property instead of a believed one. It is left undone because the standing scope for this
block is the rename and this observation and *nothing else*, and quietly widening a fence because the
addition looks small is how a fence stops meaning anything. Proposed to fm-orchestrator with the
exact change; his call, not mine.

## What I am NOT claiming

- Not that `:174` is wrong to exist. A pidfile fact is worth reporting; it is worth reporting under a
  name that says pidfile.
- Not that any operator has been misled by this in the field. I have no such observation, and the
  two rows only coexist once a mesh is up.
- Not that renaming `:174` is safe: `component.name` is a registry key used by `down` and `ext`
  (`down.ts:69`, `ext.ts:315/425`), so the display name and the key would need separating first.
  That is a change for whoever owns the local-process surface, with its own cells.

## Suggested to the owner, not done here

Render local-process rows from `component.label` (already carried, already reads `delivery daemon`)
rather than `component.name`, keeping `name` as the registry key. That separates the display name
from the key and removes the collision class rather than this instance.
