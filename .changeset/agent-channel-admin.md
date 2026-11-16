---
"@cotal-ai/core": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/cli": minor
"@cotal-ai/auth": minor
"@cotal-ai/manager": minor
---

Let agents configure channels within their publish grants through the channel-admin capability.
The seeded default persona declares it, and untouched shipped defaults migrate without changing
edited personas. The existing channel-info tool accepts configuration changes and removal at an
observed revision. The broker scopes requests to the caller's channels, the delivery host records
the writer, and conflicting edits refuse without overwriting unseen changes. Removal retains an
attributed revision record, so upgrade readers and the credential issuer together. Space defaults,
history purge and access grants remain outside this capability.
