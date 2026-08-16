---
"@cotal-ai/cli": patch
"@cotal-ai/delivery": patch
---

`cotal up` now provisions the data-account half of the membership bundle on every run, not only when a space is first created, so a space provisioned before broker-sourced membership gains the graph feed without regenerating its auth. The delivery daemon's incomplete-bundle message now names the repair that matches the missing piece instead of always pointing at a system-account rotation.
