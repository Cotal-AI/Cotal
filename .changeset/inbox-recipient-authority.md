---
"@cotal-ai/auth": patch
"@cotal-ai/core": patch
---

The auth service grants consented background recipients. A signed-in human with a fresh sign-in consents through `POST /manager-service-authority` (`inbox-recipient-consent`) for their own interactive lifecycle, with explicit `dm`/`dlv` sources and a lifetime of at most seven days. The grant is journaled before its two durables are pre-created under the scoped provisioner, and a failed provision grants nothing. The grantee redeems the grant's own secret at `POST /exchange { recipientGrant, recipientToken }` for a short bearer of the new closed `inbox-recipient` view. The auth callout re-reads the grant and mints only its six info, fetch and ACK rows plus the connection's reply inbox. Revocation (`inbox-recipient-revoke`), expiry and a lifecycle the owner no longer holds deny new redemption and delete only that grant's durables, under the new grant-pinned `recipient-deprovisioner` profile. Agents cannot consent, and the human exchange refuses the view.
