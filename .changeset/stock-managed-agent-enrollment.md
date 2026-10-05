---
"@cotal-ai/auth": patch
---

`cotal auth-service` now answers a remote manager's managed-agent enrollment and retirement preparation itself instead of refusing both for a host platform to intercept. A signed-in participant running `cotal supervise` can spawn a detached user-mode agent and terminally release it against a stock host. Enrollment runs the existing door checks, writes the managed grant at a fresh host-chosen lifecycle UID under the supervising actor's delegation envelope, provisions that UID's durables, and returns the daemon's public exchange URL for the agent's bearer; a failed provision revokes the grant. Retirement preparation releases the target UID's broker footprint and then revokes its grant. Enrollment needs the daemon's public exchange face. A platform that keeps these writers in its own storage still intercepts both kinds and uses the verify-enrollment door.
