---
"@cotal-ai/cli": minor
"@cotal-ai/workspace": minor
---

`cotal ps` on a user-auth mesh no longer class-scatters.

**Why.** The class scatter freezes the live manager set via a records-bucket `STREAM.INFO` read that only the static `control-caller-privileged` instrument holds. A user-mode bearer never has that row, so scatter died on a permissions violation that read as "no manager" — even when a manager was up and would have answered `ep.one.manager.ps`. Measured: an admin-scoped user bearer is served on `ep.one`; the same bearer is refused on the freeze.

**What changes.** Mode is chosen up front from the connection shape, never try-scatter-catch-degrade:

- **User-auth:** `ep.one` to one manager (in-memory roster, owner-filtered). Multi-manager completeness is not claimed; an unreachable manager fails the command rather than printing a bare empty list.
- **Static / open:** class scatter unchanged (freeze + per-instance attribution, unreachable labeled).

`connectOrExit` now refuses a `control-caller-*` instrument request on a user-mode mesh (those profiles are static-only); `resolveControlTarget` translates to the user bearer path explicitly. `deployer` is unchanged (real `userViewAuth` elevation). Docs state the user-mode completeness bound. Gated: `smoke:ps-operator-path` (static + dead-manager honesty) and `smoke:ps-user-mode` (user path + dead-manager non-zero).
