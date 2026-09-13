---
---

An operator upgrading a deployment that already exists now has a page to read before starting. `docs/UPGRADING.md` states the pre-1.0 upgrade contract in operator terms and carries the first release section, 0.48.2 to 0.49.0.

The section answers what a running fleet actually needs to know. Existing agent credentials keep authenticating, the channel registry survives, standalone `cotal deliver` is still supported, and `cotal join --lifecycle-uid` is not new in this release. The one thing that does not migrate is renewal: a credential minted before 0.49.0 carries no issuance, so the manager refuses to renew it and names the agent, and managed agents stop at their own credential expiry within about a day unless they are respawned. The page says to respawn the fleet as a deliberate last step rather than meet the same work one agent at a time.

It also gives the order for a split broker and manager topology, what the outage window looks like and what survives it, what to snapshot first, and the commands end to end. Where an answer was reasoned from the code rather than measured on a fleet, the page says which.

A repository check keeps it true. `scripts/upgrade-section-gate.mjs` refuses a range that carries a breaking change with no matching section on the page, and it grades itself in one invocation over three legs: breaking with no section reds and names what it caught, breaking with its section stays green, and non-breaking with no section stays green, so a gate that detects breaking changes is distinguishable from one that reds on everything. Replayed against the v0.48.2 to v0.49.0 range it refuses, naming both breaking commits.

Refs #1578
