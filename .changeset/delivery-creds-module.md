---
"@cotal-ai/delivery": patch
---

Move the delivery daemon's credential source and root resolution (the store and key that hold its cred, the daemon root, the reload identity, the cred load and the pidfile record) out of `delivery.ts` into an internal `delivery-creds.ts`. The package surface is unchanged.
