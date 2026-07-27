---
"@cotal-ai/manager": patch
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

Close two attach defects: a capability issued for the wrong agent, and remote attach silently dying after a manager repair.

**An attach capability could be issued for an incarnation nobody authorized.** `opAttach` resolved the
agent name, awaited authorization — which on a user mesh performs a ledger read, a real async
boundary — and then asked for a ticket by NAME. Ticket issuance re-resolved that name and bound
whichever agent held the slot at that moment. A stop and same-name respawn landing inside the await
therefore authorized one incarnation and handed out a valid terminal capability for its successor,
which on a user-auth mesh can belong to a different owner. `url()` now requires the authorized handle
and refuses when the slot has moved under it, and `opAttach` re-asserts the incarnation immediately
after the await so the non-pty path shares the invariant. This is the same class as the name-binding
fix in 0.14.4, one step earlier in the sequence: that closed the window at redemption, this closes it
at issuance.

**A manager replacement quietly demoted attach to loopback.** The bind host for the manager's
attach/console face was passed only on the first `cotal up` and never recorded, so every later launch
for the same mesh fell back to loopback: a same-root repair, adopting a preserved or restored
listener, and a `spawn -f` manifest deploy. The broker, the agents, and the mesh all stayed up, so the
only symptom was `cotal attach` failing to connect from another machine. It is not derivable after
the fact — a broker dial address is deliberately not treated as a manager bind address — so the
decision is now recorded on the mesh entry and read back by every manager launch. An explicit
`--host` still wins, and a mesh that never asked for exposure records nothing and stays loopback-only.

Also narrows `.cotal/manager.log` to 0600 (new and existing), since the manager's console URL is
written there and that URL carries a credential reaching every agent's terminal.
