---
"@cotal-ai/manager": patch
---

Bind an attach capability to the agent incarnation, not the reusable name.

0.14.4 made attach capabilities single-use, short-lived tickets bound to the one agent name the
manager had just authorized. A name, however, is a reusable slot rather than an identity: if the
authorized agent exits and a same-name successor takes that slot within the ticket's two-minute
lifetime, the untouched URL would attach the successor's terminal. On a per-user-auth mesh that
successor can belong to a different owner, which turns it into a cross-owner terminal handover, the
same class of boundary failure the ticket was introduced to close.

A ticket is now bound to the agent *handle* it was issued against. The manager creates a new handle
per spawn, so a successor can never compare equal to its predecessor, and redemption re-resolves the
name and requires the same incarnation. Issuing a capability for an agent that is not running is now
a loud error rather than a ticket that quietly never redeems.

Covered by two added checks in `smoke:attach-auth` (40 total): a ticket is refused once a same-name
successor occupies the slot, and `url()` refuses to issue for an unknown agent.
