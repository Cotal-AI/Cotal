---
"@cotal-ai/cli": patch
---

`cotal status` after a broker store write failure words its Next as `First <repair>; then cotal up starts the broker again with the history it kept`, as it did before the JetStream-disabled route was added, instead of ending the repair with `does first`.
