---
"@cotal-ai/connector-opencode": patch
"@cotal-ai/cli": patch
---

fix(connector-opencode): dead agents go dark — clear stale activity on idle, shim lifeline against orphaned serves, honest offline rows

A dead opencode mesh agent could haunt the roster indefinitely as `○ idle` with a stale "retrying: Rate limit exceeded…" activity, and its stale name collided with the next same-name spawn (#286). Core presence was already correct (KV TTL, stale-ts materialization, sweep); the ghost was two connector bugs plus a display gap:

- The opencode plugin's idle transitions (`session.idle`, `session.status: idle`, and `session.error` recovery) called `setStatus("idle")` bare, which leaves the previous activity untouched — so a transient `retrying: <message>` (or tool name) survived into idle, and into the agent's retained offline record, forever. Idle now clears activity on the wire.
- The serve shim only forwards signals it can catch (SIGINT/SIGTERM); a SIGKILL of the shim — exactly what the manager's hard stop sends — orphaned the `opencode serve` child, whose in-process plugin kept heartbeating presence, so the dead agent never left the mesh and its SQLite/pidfile wedged the next same-name spawn. The shim now plumbs its pid into the serve env (`COTAL_OPENCODE_SHIM_PID`) and the plugin polls it, leaving the mesh cleanly and exiting the serve once the shim is gone.
- The CLI rendered retained activity unqualified next to `⨯ offline`, indistinguishable from a live agent's. Offline rows now read as dead: `last seen <relative>` from the retained heartbeat ts, and retained activity qualified as `was: …` (`cotal endpoints` + the `cotal status` roster; new pure `relativeTime` helper).
