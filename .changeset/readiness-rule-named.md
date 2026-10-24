---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

A service definition whose `readiness` broke the schema, such as one with no `timeoutMs`, a `timeoutMs` of 0, an unknown `type`, an `http` readiness with no `url`, a status out of range or an extra field, was refused with "input does not match the version-1 definition schema at readiness" and no next step. The refusal now names the field and the rule it breaks, such as "readiness.timeoutMs must be a whole number of milliseconds from 1 to 120000", without echoing the value, and its Next says to correct readiness and add the definition again.
