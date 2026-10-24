---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
---

A credential that expires more than about 24.8 days away no longer turns off reconnect as soon as an endpoint starts. The endpoint's pre-expiry fence passed the whole remaining time to `setTimeout`, which Node runs after 1 ms for any delay above 2^31-1 ms, printing a `TimeoutOverflowWarning`. A command run with such a credential printed that warning, for instance with one of the space's own 30-day store credentials or an `auth mint --expires-in` of a month or more passed to `--creds`. A longer expiry now waits in steps. `auth mint` also refuses an `--expires-in` or `--expires-at` that ends after the last date Cotal can represent, in the year 275760, before anything is written. Before, it minted the credential and the receipt showed the expiry only as raw seconds.
