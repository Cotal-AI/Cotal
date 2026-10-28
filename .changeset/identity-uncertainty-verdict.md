---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

`identityUncertaintyRefusal` now accepts only a torn pin, a torn pairing, or an unpinned live pid. A match, a gone pid, a legacy record, a mismatch, or a pidfile with no pid is a compile error instead of a refusal that names the identity state as unsupported. The three refusing kinds keep their own sentences. A stop excludes a pidfile with no pid before the call, which that path cannot reach once a pid was parsed.
