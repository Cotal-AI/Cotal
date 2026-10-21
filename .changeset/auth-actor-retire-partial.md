---
"@cotal-ai/auth": patch
"cotal-ai": patch
---

Report `cotal actor grant` and `cotal actor revoke` honestly when the actor row changes or disappears while the predecessor's lifecycle retires. When the auth service reports that the command retired the lifecycle, the command now ends `partial` (exit 4) with the retired lifecycle under `changed` and a remedy to re-read `cotal actor list`, instead of `unknown` (exit 3). When the service reports that the lifecycle never started or was already retired, or the row has no lifecycle, the command retired nothing, so the same race refuses with `CONFLICT`, as does a first grant that finds another grant landed while it waited for the ledger lock. A retirement answer without a readable result now ends `unknown` before anything is written, instead of letting the grant or revoke continue.
