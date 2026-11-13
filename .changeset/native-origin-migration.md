---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/auth": patch
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Move fresh Cloud sign-ins to cotal.cloud and support deliberate migration of existing account registrations with fresh approval.

The old issuer must endorse the new native origin. Migration checks the same issuer, subject, audience and catalog spaces before replacing registrations. Existing service sessions and native authority records retain their saved endpoints, and upgrading alone leaves legacy registrations unchanged.
