---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
---

Manager detached-launch hardening (#159 Part B). A detached launch now reports
`started` only when the agent actually joins the mesh (presence-based readiness);
a dead-on-arrival launch surfaces as a failure with its tail output instead of a
false success, and a launch that neither joins nor exits within the backstop is
reported as uncertain rather than assumed up. On exit — despawn, crash, shutdown,
or lease loss — the manager deprovisions the agent's minted broker footprint (its
`dm_`/`dlv_` durables and ACL row) through a new target-pinned, least-privilege
`deprovisioner` profile, so exited agents no longer leave durable litter behind.
