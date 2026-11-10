---
"cotal-ai": patch
"@cotal-ai/cli": patch
---

Linux daemon installation refuses unsafe unit directories during dry runs and before changing linger.
The installer checks existing directory ancestors without creating them, then publishes the unit and its receipt before enabling linger so a later refusal remains recoverable with uninstall. It verifies the published source and directory protection again after the linger calls before requesting service registration.
