---
"@cotal-ai/auth": minor
---

`cotal service-endpoint` can now grant and revoke an approved service's callers as its owner. `callers <proposalId>` lists the instance's grantees, `grant <proposalId> --to <owner.actor> --lifecycle <uid> --commands <a,b>` lets one agent lifecycle invoke the listed commands within the approval's caller ceiling, and `revoke <grantId>` stops new issuance for a grant. A grant that already covers the commands is reported and nothing is sent, and a retry after a lost answer replays the same request.
