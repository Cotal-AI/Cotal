---
"@cotal-ai/manager": patch
---

fix(manager): schedule credential renewal so a tick lands inside `[renewAt, exp)` for any TTL

The manager scheduled `renewDaemonCreds` every `STANDING_RENEWABLE_TTL_SEC / 2`, so on a 24h
credential the ticks landed at 12h (`healthy`, no-op) and 24h (`expired`, session already
refused). `inspectCredHealth` enters `near-expiry` at 75% of iat-to-exp lifetime, so the renewal
window is only TTL/4 wide, and an interval of TTL/2 can miss it entirely for any TTL. The
manager's own daemon credential died on that ~24h cadence, as reported at 0.37.0.

The interval is now `credRenewIntervalMs(ttlSeconds) = max(1ms, TTL/4·1000)`, derived from the
caller's TTL. Ticks TTL/4 apart guarantee at least one lands in every `[renewAt, exp)` window
regardless of TTL, so both the 24h `STANDING_RENEWABLE_TTL_SEC` and the 30-day
`ROTATION_RENEWED_TTL_SEC` are covered without a hardcoded number. The renewal pass is unchanged
and idempotent, so a tick that fires before the window costs one health check per owner. Both
scheduling sites (initial start and preservation abort) are updated together.

Covered by `smoke:manager-renewal-boundary`, a real-broker cell that drives the compressed-ratio
(TTL=20s) boundary and asserts the schedule reissues inside the window, with an in-probe mutant
that reverts to TTL/2 to prove the cell reddens when the fix is reverted.
