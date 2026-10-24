---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
"cotal-ai": patch
---

A command can declare `keepsStartupNotice`. The published CLI then keeps its notice for an interrupt
before the command begins until the command's own notice takes it over, instead of ending it as the
command starts. `up` declares it, so an `up` interrupted during its recovery check, before it reaches
the stack, now says so and exits 130, 143 or 129. It used to exit with no output.
