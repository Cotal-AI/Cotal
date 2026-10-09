---
"@cotal-ai/connector-core": patch
---

`COTAL_TLS` now takes the same spellings as the other connector on/off flags. It was read as on only for the exact value `1`, so `true`, `yes` or `on` started the session without demanding TLS and, against a broker that accepts plaintext, connected unencrypted with no warning. `1`, `true`, `yes` and `on` in any case now turn TLS on, `0`, `false`, `no` and `off` keep the join link's choice, and any other value is refused at startup naming the variable.
