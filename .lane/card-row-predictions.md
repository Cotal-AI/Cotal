# The card row's live cells — NAMED predictions, written before the suite ran

Written at `c03fffe4`. The suite is `implementations/cli/smoke/delivery-card-live.smoke.ts`. It drives
the REAL caller mint (`mintDeliveryCaller`) and the REAL row (`deliveryRow`) against a real delivery
daemon on an ephemeral loopback broker.

## Why this suite exists rather than more hand-built cells

`bin/smoke/delivery-row.smoke.ts` already covers the row's DECISION with 18 hand-built cells. What it
cannot establish is the thing fm-orchestrator flagged as the honest next step: **a killed mutation
shows the test depends on the code, not that a real entry point REACHES it.** Those cells construct
their `check` seam by hand, so they would stay green even if `mintDeliveryCaller` minted a cred that
cannot read the lease at all — the exact failure the cred-class arms exist to prevent.

**So these cells build NOTHING by hand.** The caller is minted from a real space auth, connects to a
real broker, and reads a real daemon's lease.

## Named cells and predictions

| # | cell | predicted |
| --- | --- | --- |
| L1 | control: with a live daemon, `mintDeliveryCaller` returns a caller | **PASS** — without it every refusal below is about our creds, not the daemon |
| L2 | control: the row marker is `✓` and `health.serving` is true | **PASS** — the agent-class mint is what C1 measured as SERVING |
| L3 | the rendered text names its SOURCE | **PASS** |
| L4 | the rendered text names an AGE | **PASS** |
| L5 | daemon-gone: the marker is NOT `✓` | **PASS** |
| L6 | daemon-gone: the row refuses as **`no-responder`** specifically | **PASS** — C4 measured exactly this condition for an agent cred against a dead daemon |
| L7 | daemon-gone: the lease STILL reads ready, so the refusal came from the ROUND-TRIP and not from the lease | **PASS** — the residue the incident produced |
| L8 | no-auth: a caller that cannot be built renders `no-auth`, and its text does NOT claim anything about the daemon | **PASS** |

**L2 is the inverse control for L5/L6.** Without it, a suite where the marker is never `✓` would pass
L5 vacuously — the same empty-set hazard that made A5 worthless in the window until A1 went green.

**L7 is the one that ties this row to the incident.** If the lease had gone stale on daemon death,
a plain age check would have caught the outage and none of this surface would be needed. The refusal
must come from the affirmative round-trip while the lease still looks healthy, or the row is not
solving the problem it was built for.

## Falsifiers, registered

- **If L6 returns `refused` rather than `no-responder`**, the agent-class mint is NOT reaching the
  broker the way the C1/C4 arms did, and the caller in `delivery-caller.ts` is wrong even though the
  arms were right. I will report that as a defect in my wiring, not as a change to the arms' result.
- **If L2 fails**, the wiring cannot establish health on a HEALTHY mesh, which is a worse defect than
  the one this row exists to catch, and it blocks the row from shipping.

## Not claimed

These cells do not exercise `readyCard`'s string assembly (three lines in `setup.ts`). They establish
that the caller and row reach a real daemon and classify it correctly — not that the card prints them
in the right column.
