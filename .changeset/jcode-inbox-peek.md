---
"@cotal-ai/connector-jcode": patch
---

Jcode now relays the advertised `cotal_inbox` `peek` argument while preserving its host-owned
pull-only inbox scope. `peek: true` shows buffered quiet ambient without clearing it; explicit
`peek: false` and omitted arguments retain the normal destructive pull.
